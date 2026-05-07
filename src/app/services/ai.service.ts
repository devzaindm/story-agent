import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, of, map, switchMap, catchError, throwError, retry, timer } from 'rxjs';
import { environment } from '../../environments/environment';

export type WorkItemType = 'User Story' | 'Task' | 'Bug' | 'Feature';

export type GenerationIntent =
  | 'new_component'
  | 'revamp_component'
  | 'partial_update'
  | 'bug_fix'
  | 'new_service'
  | 'new_module'
  | 'style_only';

export interface WorkItemContext {
  type: WorkItemType;
  task: WorkItemFields;
  parentStory: WorkItemFields | null;
  siblings: string[];
}

export interface WorkItemFields {
  id: number;
  title: string;
  description: string;
  acceptanceCriteria: string;
  figmaFrame?: string;
}

export interface ParsedRequirements {
  intent: GenerationIntent;
  componentName: string;
  selectorName: string;
  targetExistingComponent?: string;
  scope: 'full' | 'partial';
  isNewFile: boolean;
  props: string[];
  outputs: string[];
  states: string[];
  services: string[];
  routeRequired: boolean;
  lazyLoadRequired: boolean;
  acceptanceCriteria: string[];
  technicalNotes: string;
  figmaFrame?: string;
}

export interface GeneratedOutput {
  intent: GenerationIntent;
  componentTs: string;
  componentHtml: string;
  componentScss: string;
  specTs: string;
  storybook?: string;
  modulePatch?: string;
}

export interface FigmaDesign {
  name?: string;
  figmaLink?: string;
  colors?: string[];
  spacing?: string[];
  typography?: Record<string, string>;
  componentKey?: string;
  [key: string]: unknown;
}

export interface ValidationResult {
  passed: boolean;
  issues: string[];
  suggestions: string[];
}

const ARCH_RULES = `
ARCHITECTURAL STANDARDS — follow all of these strictly:

Angular version: Angular 18 (standalone components, no NgModule unless explicitly needed)
UI libraries: Angular Material 17 + Bootstrap 5 utility classes (not Bootstrap components)
State management: ComponentStore (@ngrx/component-store) for local state; reference global store via injected facade only
HTTP: never call HttpClient directly in components — always via injected services
Forms: ReactiveFormsModule only — no Template-driven forms
Styling: SCSS with BEM naming (.block__element--modifier); use CSS custom properties for theming; no inline styles
Accessibility: ARIA labels on all interactive elements; keyboard navigation; roles where needed
Error handling: all Observables must have catchError; show user-facing error state in template
Loading state: every async operation must have a loading boolean shown in template
Change detection: ChangeDetectionStrategy.OnPush on all components
Lazy loading: feature modules/routes must be lazy loaded
Barrel exports: export through index.ts barrel files
Strict TypeScript: no 'any' types; interfaces for all data shapes; readonly where possible
Naming conventions:
  - Components: PascalCase + Component suffix
  - Services: PascalCase + Service suffix
  - Interfaces: PascalCase, no I prefix
  - Enums: PascalCase
  - Files: kebab-case.type.ts
Performance: trackBy on all *ngFor; async pipe instead of manual subscriptions
Testing: Jest; AAA pattern (Arrange/Act/Assert); mock all HTTP and services
`.trim();

@Injectable({ providedIn: 'root' })
export class AiService {
  private readonly model  = 'claude-sonnet-4-5';
  private readonly apiUrl = '/anthropic-api/v1/messages';

  constructor(private readonly http: HttpClient) {}

  private call(prompt: string, maxTokens = 4000): Observable<string> {
    const headers = new HttpHeaders({
      'x-api-key':                                 environment.anthropicApiKey,
      'anthropic-version':                         '2023-06-01',
      'content-type':                              'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    });

    const body = {
      model:      this.model,
      max_tokens: maxTokens,
      messages:   [{ role: 'user', content: prompt }],
    };

    return this.http.post<any>(this.apiUrl, body, { headers }).pipe(
      retry({
        count: 3,
        delay: (err, attempt) => {
          const isRateLimit = err?.status === 429 ||
            (err?.error?.error?.message ?? '').includes('rate limit');
          return timer(isRateLimit ? 65_000 : attempt * 3_000);
        },
      }),
      map(res => res?.content?.[0]?.text ?? ''),
      catchError(err =>
        throwError(() => new Error(
          `Anthropic API error: ${err?.error?.error?.message ?? err.message}`
        ))
      )
    );
  }

  private parseJson<T>(raw: string): T {
    const cleaned = raw
      .replace(/^```[\w]*\n?/gm, '')
      .replace(/^```\s*$/gm, '')
      .trim();

    const start = cleaned.indexOf('{');
    const end   = cleaned.lastIndexOf('}');

    if (start === -1 || end === -1) {
      throw new Error(`AI returned invalid JSON.\n\nRaw response:\n${raw.slice(0, 500)}`);
    }

    const jsonOnly = cleaned.slice(start, end + 1);

    try {
      return JSON.parse(jsonOnly) as T;
    } catch {
      throw new Error(`AI returned invalid JSON.\n\nRaw response:\n${raw.slice(0, 500)}`);
    }
  }

  detectIntent(context: WorkItemContext): Observable<GenerationIntent> {
    if (context.type === 'Bug') {
      return of<GenerationIntent>('bug_fix');
    }

    const prompt = `
Classify this Azure DevOps work item into exactly one of these intent codes:
new_component | revamp_component | partial_update | bug_fix | new_service | new_module | style_only

Work item type: ${context.type}
Title: "${context.task.title}"
Description: "${context.task.description}"
${context.parentStory ? `Parent story: "${context.parentStory.title}"` : ''}
${context.siblings.length ? `Sibling tasks already being handled: ${context.siblings.join(', ')}` : ''}

Rules:
- "add X to Y" or "implement X in existing Y" → partial_update
- "redesign", "revamp", "restyle", "overhaul" → revamp_component
- "create new", "build", "scaffold" + component → new_component
- "create service", "add service" → new_service
- "fix", "broken", "not working", "error" → bug_fix
- only CSS/template changes → style_only
- new feature area with routing → new_module

Return ONLY the intent code string, nothing else.
`.trim();

    return this.call(prompt, 50).pipe(
      map(raw => raw.trim().toLowerCase() as GenerationIntent)
    );
  }

  parseWorkItem(
    context: WorkItemContext,
    intent: GenerationIntent
  ): Observable<ParsedRequirements> {
    const prompt = `
You are a senior Angular architect. Parse this work item into structured requirements.
Return ONLY valid JSON matching the exact shape below — no markdown, no explanation.

${ARCH_RULES}

Work item type: ${context.type}
Detected intent: ${intent}
Title: "${context.task.title}"
Description: "${context.task.description}"
Acceptance criteria: "${context.task.acceptanceCriteria}"
${context.parentStory
  ? `Parent story title: "${context.parentStory.title}"
Parent story description: "${context.parentStory.description}"`
  : ''}
${context.siblings.length
  ? `Sibling tasks (DO NOT duplicate their work): ${context.siblings.join(', ')}`
  : ''}
${context.task.figmaFrame
  ? `Figma frame reference: "${context.task.figmaFrame}"`
  : ''}

Required JSON shape:
{
  "intent": "${intent}",
  "componentName": "PascalCase name",
  "selectorName": "app-kebab-case",
  "targetExistingComponent": "existing component name if revamp/partial, else null",
  "scope": "full or partial",
  "isNewFile": true or false,
  "props": ["@Input() prop names"],
  "outputs": ["@Output() event names"],
  "states": ["loading", "error", "empty", "success"],
  "services": ["AngularServiceName to inject"],
  "routeRequired": true or false,
  "lazyLoadRequired": true or false,
  "acceptanceCriteria": ["AC item 1", "AC item 2"],
  "technicalNotes": "any important technical constraints",
  "figmaFrame": "${context.task.figmaFrame ?? ''}"
}
`.trim();

    return this.call(prompt, 2000).pipe(
      map(raw => this.parseJson<ParsedRequirements>(raw))
    );
  }

  generateNewComponent(req: ParsedRequirements, design: FigmaDesign): Observable<GeneratedOutput> {
    return this.generateTs(req, design).pipe(
      switchMap(componentTs =>
        this.generateHtml(req, design).pipe(
          switchMap(componentHtml =>
            this.generateScss(req, design).pipe(
              switchMap(componentScss =>
                this.generateSpec(req).pipe(
                  map(specTs => ({
                    intent: req.intent,
                    componentTs,
                    componentHtml,
                    componentScss,
                    specTs,
                  } satisfies GeneratedOutput))
                )
              )
            )
          )
        )
      )
    );
  }

  private generateTs(req: ParsedRequirements, design: FigmaDesign): Observable<string> {
    const prompt = `
Generate ONLY the TypeScript file for this Angular 18 standalone component.
Return ONLY the raw TypeScript code — no JSON, no markdown fences, no explanation.

${ARCH_RULES}

Component: ${req.componentName} | Selector: ${req.selectorName}
Inputs: ${req.props.join(', ') || 'none'}
Outputs: ${req.outputs.join(', ') || 'none'}
States: ${req.states.join(', ')}
Services: ${req.services.join(', ') || 'none'}
AC: ${req.acceptanceCriteria.join(' | ')}
Notes: ${req.technicalNotes}
Design: ${JSON.stringify(design)}
`.trim();
    return this.call(prompt, 3500);
  }

  private generateHtml(req: ParsedRequirements, design: FigmaDesign): Observable<string> {
    const prompt = `
Generate ONLY the HTML template for this Angular 18 component.
Return ONLY the raw HTML — no JSON, no markdown fences, no explanation.

${ARCH_RULES}

Component: ${req.componentName}
States to handle: ${req.states.join(', ')}
Inputs: ${req.props.join(', ') || 'none'}
AC: ${req.acceptanceCriteria.join(' | ')}
Design tokens: ${JSON.stringify(design)}

Rules: loading skeleton, empty state, error+retry, trackBy on ngFor, ARIA labels.
`.trim();
    return this.call(prompt, 2000);
  }

  private generateScss(req: ParsedRequirements, design: FigmaDesign): Observable<string> {
    const prompt = `
Generate ONLY the SCSS for this Angular component.
Return ONLY the raw SCSS — no JSON, no markdown fences, no explanation.

Component: ${req.componentName}
Design tokens: ${JSON.stringify(design)}

Rules: BEM naming, CSS custom properties, mobile-first, Material theme vars, no hardcoded colors.
`.trim();
    return this.call(prompt, 1500);
  }

  private generateSpec(req: ParsedRequirements): Observable<string> {
    const prompt = `
Generate ONLY the Jest spec file for this Angular 18 component.
Return ONLY the raw TypeScript spec code — no JSON, no markdown fences, no explanation.

Component: ${req.componentName}
States to test: ${req.states.join(', ')}
AC: ${req.acceptanceCriteria.join(' | ')}

Rules: Jest + Angular Testing Library, AAA pattern, mock all services, test all states.
`.trim();
    return this.call(prompt, 2000);
  }

  revampComponent(
    req: ParsedRequirements,
    existingCode: { ts: string; html: string; scss: string },
    design: FigmaDesign
  ): Observable<GeneratedOutput> {
    const ctx = this.revampContext(req, existingCode, design);
    return this.revampTs(ctx).pipe(
      switchMap(componentTs =>
        this.revampHtml(ctx, componentTs).pipe(
          switchMap(componentHtml =>
            this.revampScss(ctx, componentTs, componentHtml).pipe(
              switchMap(componentScss =>
                this.revampSpec(ctx, componentTs).pipe(
                  map(specTs => ({
                    intent: req.intent, componentTs, componentHtml, componentScss, specTs,
                  } satisfies GeneratedOutput))
                )
              )
            )
          )
        )
      )
    );
  }

  private revampContext(
    req:          ParsedRequirements,
    existingCode: { ts: string; html: string; scss: string },
    design:       FigmaDesign
  ): string {
    return `
COMPONENT TO REVAMP: ${req.componentName}
Requirements: ${req.acceptanceCriteria.join('; ')}
Technical notes: ${req.technicalNotes}
Design tokens: ${JSON.stringify(design)}

EXISTING .ts:
${existingCode.ts.slice(0, 2000)}

EXISTING .html:
${existingCode.html.slice(0, 1500)}

EXISTING .scss:
${existingCode.scss.slice(0, 800)}

RULES:
• KEEP all @Input(), @Output(), public methods, injected services, business logic
• KEEP component selector and file name
• UPGRADE to ChangeDetectionStrategy.OnPush
• ADD loading/error/empty states if missing
• ADD ARIA labels
`.trim();
  }

  private revampTs(ctx: string): Observable<string> {
    return this.call(`
You are a senior Angular 18 engineer. Revamp ONLY the TypeScript file.
Return ONLY raw TypeScript — no JSON, no markdown fences, no explanation.

${ARCH_RULES}

${ctx}
`.trim(), 3500);
  }

  private revampHtml(ctx: string, newTs: string): Observable<string> {
    return this.call(`
You are a senior Angular 18 engineer. Revamp ONLY the HTML template.
Return ONLY raw HTML — no JSON, no markdown fences, no explanation.

${ARCH_RULES}

${ctx}

NEW TYPESCRIPT (already updated — match its component class):
${newTs.slice(0, 1500)}
`.trim(), 2500);
  }

  private revampScss(ctx: string, newTs: string, newHtml: string): Observable<string> {
    return this.call(`
You are a senior Angular 18 engineer. Revamp ONLY the SCSS file.
Return ONLY raw SCSS — no JSON, no markdown fences, no explanation.

${ctx}

NEW HTML classes to style:
${newHtml.slice(0, 1000)}
`.trim(), 1500);
  }

  private revampSpec(ctx: string, newTs: string): Observable<string> {
    return this.call(`
You are a senior Angular 18 engineer. Write ONLY the Jest spec file for the revamped component.
Return ONLY raw TypeScript spec — no JSON, no markdown fences, no explanation.

${ctx}

NEW TYPESCRIPT:
${newTs.slice(0, 1500)}
`.trim(), 2000);
  }

  partialUpdate(
    req: ParsedRequirements,
    existingCode: { ts: string; html: string; scss: string },
    design: FigmaDesign,
    siblingTasks: string[]
  ): Observable<GeneratedOutput> {
    const taskDesc = `
TASK (scope: partial — do only this, nothing more):
"${req.acceptanceCriteria.join('; ')}"
Technical notes: ${req.technicalNotes}
Design: ${JSON.stringify(design)}
Sibling tasks being handled separately (DO NOT implement): ${siblingTasks.join(', ') || 'none'}

RULES: minimal diff, no refactor of unrelated code, no renames.
`.trim();

    const tsPrompt = `
You are a senior Angular 18 engineer. Apply a MINIMAL change to ONLY the TypeScript file.
Return ONLY the complete updated TypeScript — no JSON, no markdown.

${ARCH_RULES}
${taskDesc}

EXISTING .ts:
${existingCode.ts}
`.trim();

    const htmlPrompt = (newTs: string) => `
You are a senior Angular 18 engineer. Apply a MINIMAL change to ONLY the HTML template.
Return ONLY the complete updated HTML — no JSON, no markdown.

${taskDesc}

EXISTING .html:
${existingCode.html}

UPDATED .ts (already changed — match it):
${newTs.slice(0, 1000)}
`.trim();

    const scssPrompt = `
You are a senior Angular 18 engineer. Add ONLY new SCSS needed for the partial update.
Return ONLY the complete updated SCSS — no JSON, no markdown.

${taskDesc}

EXISTING .scss:
${existingCode.scss}
`.trim();

    const specPrompt = (newTs: string) => `
You are a senior Angular 18 engineer. Add ONE new test case for the partial update.
Return ONLY the complete updated spec — no JSON, no markdown.

${taskDesc}

UPDATED .ts:
${newTs.slice(0, 1500)}
`.trim();

    return this.call(tsPrompt, 3500).pipe(
      switchMap(componentTs =>
        this.call(htmlPrompt(componentTs), 2000).pipe(
          switchMap(componentHtml =>
            this.call(scssPrompt, 1200).pipe(
              switchMap(componentScss =>
                this.call(specPrompt(componentTs), 1800).pipe(
                  map(specTs => ({
                    intent: req.intent, componentTs, componentHtml, componentScss, specTs,
                  } satisfies GeneratedOutput))
                )
              )
            )
          )
        )
      )
    );
  }

  fixBug(
    req: ParsedRequirements,
    existingCode: { ts: string; html: string; scss: string }
  ): Observable<GeneratedOutput> {
    const bugCtx = `
BUG: "${req.technicalNotes}"
Definition of fixed: ${req.acceptanceCriteria.join('; ')}
Component: ${req.componentName}
Rules: fix ONLY the reported bug, no unrelated refactor, add regression test.
`.trim();

    const tsPrompt = `
You are a senior Angular 18 engineer. Fix ONLY the bug in the TypeScript file.
Return ONLY the complete fixed TypeScript — no JSON, no markdown.

${ARCH_RULES}
${bugCtx}

EXISTING .ts:
${existingCode.ts}
`.trim();

    const htmlPrompt = (newTs: string) => `
Fix ONLY the bug in the HTML template if it requires a template change. If no change needed, return the existing template as-is.
Return ONLY the complete HTML — no JSON, no markdown.

${bugCtx}

EXISTING .html:
${existingCode.html}

FIXED .ts:
${newTs.slice(0, 1000)}
`.trim();

    const scssPrompt = `
Fix ONLY the bug in the SCSS if it requires a style change. If no change needed, return existing SCSS as-is.
Return ONLY the complete SCSS — no JSON, no markdown.

${bugCtx}

EXISTING .scss:
${existingCode.scss}
`.trim();

    const specPrompt = (newTs: string) => `
Add a regression test that would have caught this bug.
Return ONLY the complete spec file — no JSON, no markdown.

${bugCtx}

FIXED .ts:
${newTs.slice(0, 1500)}
`.trim();

    return this.call(tsPrompt, 3500).pipe(
      switchMap(componentTs =>
        this.call(htmlPrompt(componentTs), 2000).pipe(
          switchMap(componentHtml =>
            this.call(scssPrompt, 1200).pipe(
              switchMap(componentScss =>
                this.call(specPrompt(componentTs), 1800).pipe(
                  map(specTs => ({
                    intent: req.intent, componentTs, componentHtml, componentScss, specTs,
                  } satisfies GeneratedOutput))
                )
              )
            )
          )
        )
      )
    );
  }

  updateStyles(
    req: ParsedRequirements,
    existingCode: { html: string; scss: string },
    design: FigmaDesign
  ): Observable<Partial<GeneratedOutput>> {
    const prompt = `
You are a senior Angular engineer updating ONLY the styles of a component.
Return ONLY valid JSON with keys: componentHtml, componentScss.
Do not touch the TypeScript file at all.

${ARCH_RULES}

Design tokens from Figma: ${JSON.stringify(design)}
Style requirements: ${req.acceptanceCriteria.join('; ')}

EXISTING TEMPLATE:
${existingCode.html}

EXISTING SCSS:
${existingCode.scss}

RULES:
  • BEM naming
  • CSS custom properties for all color/spacing values
  • Mobile-first, responsive
  • No inline styles
  • Preserve all existing CSS class names used by TypeScript logic
`.trim();

    return this.call(prompt, 2500).pipe(
      map(raw => this.parseJson<Partial<GeneratedOutput>>(raw))
    );
  }

  generateService(req: ParsedRequirements): Observable<string> {
    const prompt = `
You are a senior Angular 18 engineer. Generate a production-ready Angular service.
Return ONLY the TypeScript source code — no JSON wrapper, no markdown.

${ARCH_RULES}

Service name: ${req.componentName}Service
Purpose derived from: "${req.acceptanceCriteria.join('; ')}"
Technical notes: ${req.technicalNotes}

Rules:
  • @Injectable({ providedIn: 'root' })
  • All HTTP calls use HttpClient with typed response interfaces
  • All methods return Observable (never Promise)
  • Comprehensive error handling with catchError
  • Use environment variables for API URLs
  • Add JSDoc comment on each public method
`.trim();

    return this.call(prompt, 3500);
  }

  validateOutput(
    output: GeneratedOutput,
    requirements: ParsedRequirements
  ): Observable<ValidationResult> {
    const prompt = `
Review this generated Angular component against the acceptance criteria.
Return ONLY valid JSON — no markdown.

Acceptance criteria to verify:
${requirements.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n')}

Generated component TypeScript:
${output.componentTs.slice(0, 3000)}

Generated template:
${output.componentHtml.slice(0, 2000)}

Check for:
1. Does the code satisfy each acceptance criterion?
2. Are there any obvious TypeScript errors?
3. Is ChangeDetectionStrategy.OnPush used?
4. Are loading/error/empty states handled in the template?
5. Are there any security issues (XSS, injection)?

Return JSON:
{
  "passed": true or false,
  "issues": ["list of problems found"],
  "suggestions": ["list of improvements"]
}
`.trim();

    return this.call(prompt, 800).pipe(
      map(raw => this.parseJson<ValidationResult>(raw))
    );
  }

  generatePRDescription(
    context: WorkItemContext,
    output: GeneratedOutput,
    validation: ValidationResult
  ): Observable<string> {
    const knownIssuesSection = !validation.passed
      ? `## Known issues (auto-detected)\n${validation.issues.map(i => `- ${i}`).join('\n')}`
      : '';

    const prompt = `
Write a professional Azure DevOps pull request description in Markdown.
Return only the Markdown text, no JSON wrapper.

Work item: ${context.task.title} (#${context.task.id})
${context.parentStory
  ? `Parent story: ${context.parentStory.title} (#${context.parentStory.id})`
  : ''}
Intent: ${output.intent}
Acceptance criteria:
${context.task.acceptanceCriteria}

Include sections:
## Summary
## Changes made
## Acceptance criteria checklist (checkboxes)
## Testing notes
## Screenshots / Figma reference
${knownIssuesSection}

Link work items using AB#${context.task.id} syntax.
Keep it concise and professional.
`.trim();

    return this.call(prompt, 1500);
  }
}
