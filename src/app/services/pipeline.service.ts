import { Injectable } from '@angular/core';
import { Observable, of, forkJoin, from, map, switchMap, tap, catchError, throwError } from 'rxjs';
import { environment } from '../../environments/environment';

import { AzureService }   from './azure.service';
import { FigmaService }   from './figma.service';
import { PrService, PrConfig, PrResult } from './pr.service';
import { CodebaseScannerService, FileLookupResult } from './scanner.service';
import { LocalFsService } from './local-fs.service';
import {
  AiService,
  WorkItemContext,
  GenerationIntent,
  ParsedRequirements,
  GeneratedOutput,
  FigmaDesign,
  ValidationResult,
} from './ai.service';

export interface PrepareResult {
  context:        WorkItemContext;
  intent:         GenerationIntent;
  requirements:   ParsedRequirements;
  output:         GeneratedOutput;
  validation:     ValidationResult;
  locationResult: FileLookupResult;
  design:         FigmaDesign;
}

export interface PipelineResult {
  prUrl:                string;
  prId:                 number;
  sourceBranch:         string;
  targetBranch:         string;
  filesCommitted:       string[];
  wasExistingComponent: boolean;
  intent:               GenerationIntent;
}

export interface LocalWriteResult {
  filesWritten:         string[];
  wasExistingComponent: boolean;
  intent:               GenerationIntent;
}

@Injectable({ providedIn: 'root' })
export class PipelineService {

  constructor(
    private readonly azure:   AzureService,
    private readonly ai:      AiService,
    private readonly figma:   FigmaService,
    private readonly pr:      PrService,
    private readonly scanner: CodebaseScannerService,
    private readonly localFs: LocalFsService,
  ) {}

  prepare(
    workItemId: string,
    onStatus:   (msg: string) => void
  ): Observable<PrepareResult> {

    onStatus('Reading work item from Azure DevOps...');

    type Step4Result = {
      context:        WorkItemContext;
      intent:         GenerationIntent;
      requirements:   ParsedRequirements;
      locationResult: FileLookupResult;
      design:         FigmaDesign;
      output:         GeneratedOutput;
    };

    const steps1to4$: Observable<Step4Result> = this.azure.getWorkItemWithContext(workItemId).pipe(

      tap(ctx => onStatus(`"${ctx.task.title}" (${ctx.type}) — detecting intent...`)),

      switchMap(context =>
        this.ai.detectIntent(context).pipe(
          map(intent => ({ context, intent }))
        )
      ),

      tap(({ intent }) => onStatus(`Intent: ${intent} — scanning codebase + parsing...`)),

      switchMap(({ context, intent }) =>
        forkJoin({
          requirements:   this.ai.parseWorkItem(context, intent),
          locationResult: this.scanner.resolveComponentLocation(
            this.extractComponentHint(context),
            intent,
            `${context.task.title} ${context.task.description} ${context.task.acceptanceCriteria}`
          ),
        }).pipe(
          map(result => ({ context, intent, ...result }))
        )
      ),

      tap(({ requirements, locationResult }) => {
        onStatus(`Component: ${requirements.componentName}`);
        onStatus(
          locationResult.found && locationResult.location
            ? `Found existing file: ${locationResult.location.tsPath}`
            : `New file — path resolved: ${locationResult.resolvedPaths?.ts ?? 'pending'}`
        );
      }),

      switchMap(({ context, intent, requirements, locationResult }) => {
        const figmaHint =
          context.task.figmaFrame ??
          requirements.figmaFrame ??
          context.parentStory?.figmaFrame ??
          context.task.title;

        onStatus(`Fetching Figma design for "${figmaHint}"...`);

        const needsExistingCode = (
          intent === 'revamp_component' ||
          intent === 'partial_update'   ||
          intent === 'bug_fix'          ||
          intent === 'style_only'
        );

        const existingCode$ = needsExistingCode && locationResult.location
          ? this.scanner.readComponentFiles(locationResult.location.tsPath)
          : of(null);

        return forkJoin({
          design:       this.figma.findBestFrame(figmaHint),
          existingCode: existingCode$,
        }).pipe(
          map(result => ({ context, intent, requirements, locationResult, ...result }))
        );
      }),

      tap(() => onStatus('Generating code...')),

      switchMap(({ context, intent, requirements, locationResult, design, existingCode }): Observable<Step4Result> =>
        this.dispatchGeneration(intent, requirements, design, existingCode, context.siblings).pipe(
          map(output => ({ context, intent, requirements, locationResult, design, output }))
        )
      ),
    );

    return steps1to4$.pipe(

      tap(() => onStatus('Validating generated code...')),

      switchMap(({ context, intent, requirements, locationResult, design, output }): Observable<PrepareResult> =>
        this.ai.validateOutput(output, requirements).pipe(
          map(validation => ({ context, intent, requirements, locationResult, design, output, validation }))
        )
      ),

      tap(({ validation }) => {
        if (!validation.passed) {
          onStatus(`Validation warnings: ${validation.issues.join(' | ')}`);
        } else {
          onStatus('Validation passed — ready for your review');
        }
      }),

      catchError(err =>
        throwError(() => new Error(`Pipeline.prepare failed: ${err.message}`))
      )
    );
  }

  submit(
    prepared:  PrepareResult,
    onStatus:  (msg: string) => void
  ): Observable<PipelineResult> {

    onStatus('Generating PR description...');

    return this.ai.generatePRDescription(
      prepared.context,
      prepared.output,
      prepared.validation
    ).pipe(

      tap(() => onStatus('Creating branch and committing files...')),

      switchMap(() => {
        const config: PrConfig = {
          targetBranch:  environment.revampTargetBranch,
          componentName: prepared.requirements.componentName,
        };

        const resolvedPaths = prepared.locationResult.resolvedPaths;

        if (!resolvedPaths) {
          return throwError(() => new Error(
            'Cannot submit — component file paths could not be resolved.'
          ));
        }

        return this.pr.createRevampPR(
          prepared.context,
          prepared.output,
          config,
          resolvedPaths
        );
      }),

      tap(result => {
        onStatus(`PR #${result.prId} created as Draft`);
        onStatus(`Branch: ${result.sourceBranch} → ${result.targetBranch}`);
        onStatus(`Files committed: ${result.filesCommitted.join(', ')}`);
      }),

      map(result => ({
        prUrl:                result.prUrl,
        prId:                 result.prId,
        sourceBranch:         result.sourceBranch,
        targetBranch:         result.targetBranch,
        filesCommitted:       result.filesCommitted,
        wasExistingComponent: prepared.locationResult.found,
        intent:               prepared.intent,
      } satisfies PipelineResult)),

      catchError(err =>
        throwError(() => new Error(`Pipeline.submit failed: ${err.message}`))
      )
    );
  }

  writeLocally(
    prepared: PrepareResult,
    onStatus: (msg: string) => void
  ): Observable<LocalWriteResult> {
    const paths  = prepared.locationResult.resolvedPaths;
    const output = prepared.output;

    if (!paths) {
      return throwError(() => new Error('Cannot write locally — file paths could not be resolved.'));
    }

    const files = ([
      { path: paths.ts,   content: output.componentTs   },
      { path: paths.html, content: output.componentHtml },
      { path: paths.scss, content: output.componentScss },
      { path: paths.spec, content: output.specTs        },
    ] as Array<{ path: string; content: string }>)
      .filter(f => f.content?.trim().length > 0);

    onStatus(`Writing ${files.length} file(s) to local project...`);

    return this.localFs.writeAll(files).pipe(
      tap(written => {
        written.forEach(p => onStatus(`Written: ${p}`));
      }),
      map(filesWritten => ({
        filesWritten,
        wasExistingComponent: prepared.locationResult.found,
        intent:               prepared.intent,
      } satisfies LocalWriteResult)),
      catchError(err =>
        throwError(() => new Error(`writeLocally failed: ${err.message}`))
      )
    );
  }

  private dispatchGeneration(
    intent:       GenerationIntent,
    req:          ParsedRequirements,
    design:       FigmaDesign,
    existingCode: { ts: string; html: string; scss: string } | null,
    siblings:     string[]
  ): Observable<GeneratedOutput> {

    switch (intent) {
      case 'new_component':
        return this.ai.generateNewComponent(req, design);

      case 'revamp_component':
        if (!existingCode) return throwError(() =>
          new Error(`revamp_component: existing code not found for ${req.componentName}`)
        );
        return this.ai.revampComponent(req, existingCode, design);

      case 'partial_update':
        if (!existingCode) return throwError(() =>
          new Error(`partial_update: existing code not found for ${req.componentName}`)
        );
        return this.ai.partialUpdate(req, existingCode, design, siblings);

      case 'bug_fix':
        if (!existingCode) return throwError(() =>
          new Error(`bug_fix: existing code not found for ${req.componentName}`)
        );
        return this.ai.fixBug(req, existingCode);

      case 'style_only':
        if (!existingCode) return throwError(() =>
          new Error(`style_only: existing code not found for ${req.componentName}`)
        );
        return this.ai.updateStyles(req, existingCode, design).pipe(
          map(partial => ({
            intent,
            componentTs:   existingCode.ts,
            componentHtml: partial.componentHtml ?? existingCode.html,
            componentScss: partial.componentScss ?? existingCode.scss,
            specTs:        '',
          } satisfies GeneratedOutput))
        );

      case 'new_service':
        return this.ai.generateService(req).pipe(
          map(code => ({
            intent,
            componentTs:   code,
            componentHtml: '',
            componentScss: '',
            specTs:        '',
          } satisfies GeneratedOutput))
        );

      case 'new_module':
        return this.ai.generateNewComponent(req, design);

      default:
        return throwError(() => new Error(`Unknown intent: ${intent}`));
    }
  }

  private extractComponentHint(context: WorkItemContext): string {
    const STRIP = new Set([
      'add', 'fix', 'update', 'revamp', 'create', 'implement', 'build', 'new',
      'fe', 'ui', 'ux', 'screen', 'page', 'view', 'feature', 'module',
      'component', 'redesign', 'rework', 'refactor', 'task', 'story',
    ]);

    return context.task.title
      .replace(/^\[.*?\]\s*/, '')
      .split(/[\s\-_]+/)
      .filter(w => w.length > 1 && !STRIP.has(w.toLowerCase()))
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join('');
  }
}
