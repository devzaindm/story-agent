import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, forkJoin, map, of, switchMap, catchError } from 'rxjs';
import { environment } from '../../environments/environment';
import { LocalFsService } from './local-fs.service';

export interface ComponentLocation {
  tsPath:     string;
  htmlPath:   string;
  scssPath:   string;
  specPath:   string;
  folder:     string;
  confidence: number;
  reason:     string;
}

export interface CodebaseStructure {
  pattern:              'features' | 'modules' | 'components' | 'mixed';
  featureRoot:          string;
  allComponents:        string[];
  exampleFolderPattern: string;
}

export interface FileLookupResult {
  found:             boolean;
  location:          ComponentLocation | null;
  codebaseStructure: CodebaseStructure;
  resolvedPaths: {
    ts:   string;
    html: string;
    scss: string;
    spec: string;
  } | null;
}

const NEEDS_EXISTING: string[] = ['revamp_component', 'partial_update', 'bug_fix', 'style_only'];
const ALWAYS_NEW: string[]     = ['new_component', 'new_service', 'new_module'];

@Injectable({ providedIn: 'root' })
export class CodebaseScannerService {
  private readonly org     = environment.azureOrg;
  private readonly project = environment.azureProject;
  private readonly repo    = environment.azureRepo;
  private readonly branch  = environment.revampTargetBranch;
  private readonly apiBase = `https://dev.azure.com/${this.org}/${this.project}/_apis`;

  constructor(
    private readonly http:    HttpClient,
    private readonly localFs: LocalFsService,
  ) {}

  private get headers(): HttpHeaders {
    return new HttpHeaders({
      'Content-Type':  'application/json',
      'Authorization': `Basic ${btoa(':' + environment.azureToken)}`,
    });
  }

  resolveComponentLocation(
    componentName: string,
    intent:        string,
    storyContext:  string
  ): Observable<FileLookupResult> {
    if (NEEDS_EXISTING.includes(intent)) {
      const explicit = this.extractExplicitPath(storyContext);
      if (explicit) {
        const location = this.buildLocation(explicit, 1, 'explicit path from work item');
        return of({
          found:             true,
          location,
          codebaseStructure: this.emptyStructure(),
          resolvedPaths:     { ts: location.tsPath, html: location.htmlPath, scss: location.scssPath, spec: location.specPath },
        } satisfies FileLookupResult);
      }
    }

    return this.getAllComponentPaths().pipe(
      switchMap(allComponents => {
        const codebaseStructure = this.inferStructure(allComponents);

        if (ALWAYS_NEW.includes(intent)) {
          return this.resolveNewComponentPath(componentName, storyContext, codebaseStructure, allComponents).pipe(
            map(resolved => ({
              found: false, location: null, codebaseStructure, resolvedPaths: resolved,
            } satisfies FileLookupResult))
          );
        }

        if (NEEDS_EXISTING.includes(intent)) {
          return this.findExistingComponent(componentName, storyContext, allComponents, codebaseStructure).pipe(
            map(location => ({
              found:         !!location,
              location:      location ?? null,
              codebaseStructure,
              resolvedPaths: location
                ? { ts: location.tsPath, html: location.htmlPath, scss: location.scssPath, spec: location.specPath }
                : null,
            } satisfies FileLookupResult))
          );
        }

        return of({ found: false, location: null, codebaseStructure, resolvedPaths: null } satisfies FileLookupResult);
      }),
      catchError(() => of({ found: false, location: null, codebaseStructure: this.emptyStructure(), resolvedPaths: null } satisfies FileLookupResult))
    );
  }

  private extractExplicitPath(text: string): string | null {
    const prefixMatch = text.match(/path\s*:\s*([\w\\/.\-]+)/i);
    if (prefixMatch) {
      const raw = prefixMatch[1].replace(/\\/g, '/').replace(/\/+$/, '');
      if (raw.endsWith('.component.ts')) {
        return raw.startsWith('/') ? raw : `/${raw}`;
      }
      const lastSegment = raw.split('/').pop() ?? '';
      const tsPath = `${raw}/${lastSegment}.component.ts`;
      return tsPath.startsWith('/') ? tsPath : `/${tsPath}`;
    }

    const fileMatch = text.match(/\/?src\/app\/[\w\-/]+\.component\.ts/i);
    if (fileMatch) {
      const raw = fileMatch[0];
      return raw.startsWith('/') ? raw : `/${raw}`;
    }
    return null;
  }

  getAllComponentPaths(): Observable<string[]> {
    return this.localFs.listComponents().pipe(
      switchMap(local => {
        if (local.length > 0) return of(local);

        const params = new URLSearchParams({
          scopePath:                       '/src',
          recursionLevel:                  'Full',
          'versionDescriptor.version':     this.branch,
          'versionDescriptor.versionType': 'branch',
          'api-version':                   '7.0',
        });
        return this.http
          .get<{ value: Array<{ gitObjectType: string; path: string }> }>(
            `${this.apiBase}/git/repositories/${this.repo}/items?${params}`,
            { headers: this.headers }
          )
          .pipe(
            map(res =>
              (res?.value ?? [])
                .filter(i => i.gitObjectType === 'blob' && i.path.endsWith('.component.ts'))
                .map(i => i.path)
            ),
            catchError(() => of([] as string[]))
          );
      })
    );
  }

  readFile(filePath: string): Observable<string> {
    return this.localFs.readFile(filePath).pipe(
      switchMap(content => {
        if (content) return of(content);

        const params = new URLSearchParams({
          path:                            filePath,
          'versionDescriptor.version':     this.branch,
          'versionDescriptor.versionType': 'branch',
          'api-version':                   '7.0',
        });
        return this.http
          .get(
            `${this.apiBase}/git/repositories/${this.repo}/items?${params}`,
            { headers: this.headers, responseType: 'text' }
          )
          .pipe(catchError(() => of('')));
      })
    );
  }

  readComponentFiles(tsPath: string): Observable<{ ts: string; html: string; scss: string }> {
    return this.localFs.readComponentFiles(tsPath).pipe(
      switchMap(files => {
        if (files.ts) return of(files);
        return forkJoin({
          ts:   this.readFile(tsPath),
          html: this.readFile(tsPath.replace('.component.ts', '.component.html')),
          scss: this.readFile(tsPath.replace('.component.ts', '.component.scss')),
        });
      })
    );
  }

  private findExistingComponent(
    componentName: string,
    storyContext:  string,
    allPaths:      string[],
    _structure:    CodebaseStructure
  ): Observable<ComponentLocation | null> {
    if (allPaths.length === 0) return of(null);

    const GENERIC = new Set([
      'component', 'screen', 'view', 'page', 'list', 'form', 'table',
      'modal', 'dialog', 'panel', 'widget', 'item', 'card', 'detail',
      'revamp', 'update', 'new', 'edit', 'create', 'add', 'fix',
      'fe', 'ui', 'ux',
    ]);

    const kebab = this.toKebab(componentName);
    const words = kebab.split('-').filter(w => w.length > 2 && !GENERIC.has(w));

    if (words.length === 0) return of(null);

    const scored = allPaths.map(path => {
      const fileName  = path.split('/').pop()?.replace('.component.ts', '') ?? '';
      const fileLower = fileName.toLowerCase();
      const pathLower = path.toLowerCase();

      const exactFileMatch = fileName === kebab ? 100 : 0;
      const fileWordScore  = words.reduce((acc, word) => acc + (fileLower.includes(word) ? 10 : 0), 0);
      const pathWordScore  = words.reduce((acc, word) => acc + (pathLower.includes(word) ? 1  : 0), 0);

      return { path, score: exactFileMatch + fileWordScore + pathWordScore };
    })
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

    if (scored.length === 0) return of(null);

    const top = scored[0];

    if (top.score >= 10) {
      return of(this.buildLocation(
        top.path,
        Math.min(top.score / 100, 1),
        top.score >= 100 ? 'exact filename match' : 'filename keyword match'
      ));
    }

    return this.aiPickBestMatch(componentName, storyContext, scored.map(c => c.path)).pipe(
      map(picked =>
        picked
          ? this.buildLocation(picked, 0.8, 'AI semantic match')
          : this.buildLocation(top.path, top.score / 100, 'low confidence fallback — verify in UI')
      )
    );
  }

  private aiPickBestMatch(
    componentName: string,
    storyContext:  string,
    candidates:    string[]
  ): Observable<string | null> {
    const prompt = `
You are helping find which Angular component file matches a work item.
Component name: "${componentName}"
Work item context: "${storyContext}"

Candidate paths:
${candidates.map((p, i) => `${i + 1}. ${p}`).join('\n')}

Return ONLY the number of the best match (1, 2, 3...).
If none match, return 0.
`.trim();

    return this.callAi(prompt).pipe(
      map(text => {
        const idx = parseInt(text.trim(), 10);
        if (!idx || idx < 1 || idx > candidates.length) return null;
        return candidates[idx - 1];
      }),
      catchError(() => of(candidates[0] ?? null))
    );
  }

  private resolveNewComponentPath(
    componentName: string,
    storyContext:  string,
    structure:     CodebaseStructure,
    allPaths:      string[]
  ): Observable<{ ts: string; html: string; scss: string; spec: string }> {
    const kebab         = this.toKebab(componentName);
    const uniqueFolders = [...new Set(allPaths.map(p => p.split('/').slice(0, -1).join('/')))];

    const prompt = `
You are an Angular architect placing a new component in an existing project.

New component: "${componentName}" (file: ${kebab}.component.ts)
Story context: "${storyContext}"
Project pattern: ${structure.pattern}
Feature root: ${structure.featureRoot}

Existing folders:
${uniqueFolders.slice(0, 30).join('\n')}

Return ONLY the parent folder path where the new component folder should be created.
Do NOT include the component folder itself.
Example: src/app/features/checkout
`.trim();

    return this.callAi(prompt).pipe(
      map(raw => this.buildPaths(raw.trim().replace(/\/+$/, ''), kebab)),
      catchError(() => of(this.buildPaths(`${structure.featureRoot}/${kebab}`, kebab)))
    );
  }

  private inferStructure(allPaths: string[]): CodebaseStructure {
    const has = (seg: string): boolean => allPaths.some(p => p.includes(`/${seg}/`));

    let pattern:    CodebaseStructure['pattern'] = 'mixed';
    let featureRoot = 'src/app';

    if      (has('features') && !has('modules'))  { pattern = 'features';   featureRoot = 'src/app/features';   }
    else if (has('modules')  && !has('features'))  { pattern = 'modules';    featureRoot = 'src/app/modules';    }
    else if (has('components') && !has('features') && !has('modules')) {
                                                    pattern = 'components';  featureRoot = 'src/app/components'; }

    const depthCounts: Record<number, number> = {};
    allPaths.forEach(p => {
      const d = p.split('/').length;
      depthCounts[d] = (depthCounts[d] ?? 0) + 1;
    });
    const commonDepth = +(Object.entries(depthCounts).sort((a, b) => +b[1] - +a[1])[0]?.[0] ?? 5);
    const example     = allPaths.find(p => p.split('/').length === commonDepth) ?? allPaths[0] ?? '';

    return {
      pattern,
      featureRoot,
      allComponents:        allPaths,
      exampleFolderPattern: example.split('/').slice(0, -1).join('/'),
    };
  }

  private buildLocation(tsPath: string, confidence: number, reason: string): ComponentLocation {
    return {
      tsPath,
      htmlPath: tsPath.replace('.component.ts', '.component.html'),
      scssPath: tsPath.replace('.component.ts', '.component.scss'),
      specPath: tsPath.replace('.component.ts', '.component.spec.ts'),
      folder:   tsPath.split('/').slice(0, -1).join('/'),
      confidence,
      reason,
    };
  }

  private buildPaths(parentFolder: string, kebab: string): { ts: string; html: string; scss: string; spec: string } {
    const base = `${parentFolder}/${kebab}/${kebab}.component`;
    return { ts: `${base}.ts`, html: `${base}.html`, scss: `${base}.scss`, spec: `${base}.spec.ts` };
  }

  private emptyStructure(): CodebaseStructure {
    return { pattern: 'mixed', featureRoot: 'src/app', allComponents: [], exampleFolderPattern: 'src/app' };
  }

  private toKebab(pascal: string): string {
    return pascal.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
  }

  private callAi(prompt: string): Observable<string> {
    const provider = environment.aiProvider ?? 'groq';
    return this.http
      .post<unknown>(this.aiUrl(provider), this.aiBody(provider, prompt), { headers: this.aiHeaders(provider) })
      .pipe(
        map(res => this.aiExtract(provider, res)),
        catchError(() => of('0'))
      );
  }

  private aiUrl(provider: string): string {
    const urls: Record<string, string> = {
      anthropic:  '/anthropic-api/v1/messages',
      groq:       'https://api.groq.com/openai/v1/chat/completions',
      gemini:     `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${environment.geminiApiKey}`,
      openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    };
    return urls[provider] ?? urls['groq'];
  }

  private aiBody(provider: string, prompt: string): object {
    if (provider === 'anthropic') {
      return { model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: prompt }] };
    }
    if (provider === 'gemini') {
      return { contents: [{ parts: [{ text: prompt }] }] };
    }
    return {
      model:       provider === 'openrouter' ? 'meta-llama/llama-3.1-8b-instruct:free' : 'llama-3.3-70b-versatile',
      messages:    [{ role: 'user', content: prompt }],
      max_tokens:  64,
      temperature: 0,
    };
  }

  private aiHeaders(provider: string): HttpHeaders {
    const base = { 'Content-Type': 'application/json' };
    if (provider === 'anthropic') {
      return new HttpHeaders({
        ...base,
        'x-api-key':                                 environment.anthropicApiKey,
        'anthropic-version':                         '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      });
    }
    return new HttpHeaders(base);
  }

  private aiExtract(provider: string, res: unknown): string {
    if (provider === 'anthropic') return (res as any)?.content?.[0]?.text                        ?? '0';
    if (provider === 'gemini')    return (res as any)?.candidates?.[0]?.content?.parts?.[0]?.text ?? '0';
    return                               (res as any)?.choices?.[0]?.message?.content             ?? '0';
  }
}
