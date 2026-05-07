import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, map, switchMap, catchError, throwError } from 'rxjs';
import { environment } from '../../environments/environment';
import { GeneratedOutput, WorkItemContext } from './ai.service';

export interface PrConfig {
  targetBranch:  string;
  componentName: string;
}

export interface PrResult {
  prUrl:          string;
  prId:           number;
  sourceBranch:   string;
  targetBranch:   string;
  filesCommitted: string[];
}

const EXCLUDED_PATTERNS = [
  'angular.json', 'package.json', 'package-lock.json', 'yarn.lock',
  '.env', 'environment.ts', 'environment.prod.ts', 'proxy.conf.json',
  'app-routing.module.ts', 'app.module.ts', 'CLAUDE.md', '.gitignore',
  'README.md', 'tsconfig', 'karma.conf', '.editorconfig',
  'story-agent', 'agents/services',
];

function isExcluded(filePath: string): boolean {
  return EXCLUDED_PATTERNS.some(p => filePath.toLowerCase().includes(p.toLowerCase()));
}

interface CommitFile {
  path:    string;
  content: string;
}

@Injectable({ providedIn: 'root' })
export class PrService {
  private readonly org     = environment.azureOrg;
  private readonly project = environment.azureProject;
  private readonly repo    = environment.azureRepo
    ?? (() => { console.warn('azureRepo not set'); return environment.azureProject; })();

  private readonly repoBase =
    `https://dev.azure.com/${environment.azureOrg}/${environment.azureProject}/_apis/git/repositories/${environment.azureRepo}`;

  private get headers(): HttpHeaders {
    return new HttpHeaders({
      'Authorization': `Basic ${btoa(':' + environment.azureToken)}`,
      'Content-Type':  'application/json',
    });
  }

  constructor(private readonly http: HttpClient) {}

  createRevampPR(
    context:       WorkItemContext,
    output:        GeneratedOutput,
    config:        PrConfig,
    resolvedPaths: { ts: string; html: string; scss: string; spec: string }
  ): Observable<PrResult> {
    const files = this.buildFileList(output, resolvedPaths);

    if (files.length === 0) {
      return throwError(() => new Error(
        'No files to commit — all resolved paths were excluded by the safety filter.'
      ));
    }

    const kebab        = this.toKebab(config.componentName);
    const sourceBranch = `agent/task-${context.task.id}-${kebab}`;

    return this.getLatestCommit(config.targetBranch).pipe(
      switchMap(sha => this.createBranch(sourceBranch, sha)),
      switchMap(sha => this.pushFiles(sourceBranch, sha, files, context)),
      switchMap(() => this.openPR(sourceBranch, config.targetBranch, context, files)),
      catchError(err =>
        throwError(() => new Error(`PrService.createRevampPR: ${err.message}`))
      )
    );
  }

  private getLatestCommit(branchName: string): Observable<string> {
    const encoded = encodeURIComponent(branchName);
    return this.http
      .get<any>(
        `${this.repoBase}/refs?filter=heads/${encoded}&api-version=7.0`,
        { headers: this.headers }
      )
      .pipe(
        map(res => {
          const sha = res?.value?.[0]?.objectId;
          if (!sha) throw new Error(`Branch "${branchName}" not found in repo "${this.repo}".`);
          return sha as string;
        }),
        catchError(err => throwError(() => new Error(`getLatestCommit: ${err.message}`)))
      );
  }

  private createBranch(newBranch: string, fromSha: string): Observable<string> {
    const body = [{
      name:        `refs/heads/${newBranch}`,
      newObjectId: fromSha,
      oldObjectId: '0000000000000000000000000000000000000000',
    }];

    return this.http
      .post<any>(`${this.repoBase}/refs?api-version=7.0`, body, { headers: this.headers })
      .pipe(
        map(res => {
          const result = res?.value?.[0];
          if (!result?.success && !result?.updateStatus?.includes('succeeded')) {
            throw new Error(`Could not create branch "${newBranch}". It may already exist.`);
          }
          return fromSha;
        }),
        catchError(err => throwError(() => new Error(`createBranch: ${err.message}`)))
      );
  }

  private pushFiles(
    branchName: string,
    parentSha:  string,
    files:      CommitFile[],
    context:    WorkItemContext
  ): Observable<void> {
    const storyRef = context.parentStory ? ` (Story #${context.parentStory.id})` : '';

    const changes = files.map(f => ({
      changeType: 'add',
      item:       { path: f.path },
      newContent: {
        content:     btoa(unescape(encodeURIComponent(f.content))),
        contentType: 'base64Encoded',
      },
    }));

    const body = {
      refUpdates: [{ name: `refs/heads/${branchName}`, oldObjectId: parentSha }],
      commits: [{
        comment: `feat(agent): ${context.task.title} — Task #${context.task.id}${storyRef}`,
        changes,
      }],
    };

    return this.http
      .post<any>(`${this.repoBase}/pushes?api-version=7.0`, body, { headers: this.headers })
      .pipe(
        map(() => void 0),
        catchError(err => throwError(() => new Error(`pushFiles: ${err.message}`)))
      );
  }

  private openPR(
    sourceBranch: string,
    targetBranch: string,
    context:      WorkItemContext,
    files:        CommitFile[]
  ): Observable<PrResult> {
    const taskId   = context.task.id;
    const storyId  = context.parentStory?.id;
    const fileList = files.map(f => `- \`${f.path}\``).join('\n');

    const acLines = context.task.acceptanceCriteria
      ? context.task.acceptanceCriteria
          .split('\n').filter(Boolean)
          .map(ac => `- [ ] ${ac.trim()}`).join('\n')
      : '- [ ] See work item';

    const description = [
      `## ${context.task.title}`,
      ``,
      `> Auto-generated by Story Agent — review before merging into \`${targetBranch}\`.`,
      ``,
      `**Intent:** ${context.type}`,
      `**Target branch:** \`${targetBranch}\``,
      ``,
      `### Files changed`,
      fileList,
      ``,
      `### Acceptance criteria`,
      acLines,
      ``,
      `### Work items`,
      `AB#${taskId}`,
      storyId ? `AB#${storyId}` : '',
    ].filter(l => l !== undefined).join('\n');

    const body = {
      title:          `[Agent] ${context.task.title} — Task #${taskId}`,
      description,
      sourceRefName:  `refs/heads/${sourceBranch}`,
      targetRefName:  `refs/heads/${targetBranch}`,
      isDraft:        true,
      workItemRefs:   [{ id: String(taskId) }, ...(storyId ? [{ id: String(storyId) }] : [])],
    };

    return this.http
      .post<any>(`${this.repoBase}/pullrequests?api-version=7.0`, body, { headers: this.headers })
      .pipe(
        map(pr => ({
          prUrl:          `https://dev.azure.com/${this.org}/${this.project}/_git/${this.repo}/pullrequest/${pr.pullRequestId}`,
          prId:           pr.pullRequestId as number,
          sourceBranch,
          targetBranch,
          filesCommitted: files.map(f => f.path),
        } satisfies PrResult)),
        catchError(err => throwError(() => new Error(`openPR: ${err.message}`)))
      );
  }

  private buildFileList(
    output:        GeneratedOutput,
    resolvedPaths: { ts: string; html: string; scss: string; spec: string }
  ): CommitFile[] {
    return ([
      { path: resolvedPaths.ts,   content: output.componentTs   },
      { path: resolvedPaths.html, content: output.componentHtml },
      { path: resolvedPaths.scss, content: output.componentScss },
      { path: resolvedPaths.spec, content: output.specTs        },
    ] as CommitFile[])
      .filter(f => f.content?.trim().length > 0)
      .filter(f => !isExcluded(f.path));
  }

  private toKebab(pascal: string): string {
    return pascal.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
  }
}
