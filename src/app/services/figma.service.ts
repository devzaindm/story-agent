import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, of, forkJoin, map, switchMap, catchError } from 'rxjs';
import { environment } from '../../environments/environment';
import { FigmaDesign } from './ai.service';

interface FigmaFileResponse {
  document: FigmaNode;
  styles:   Record<string, FigmaStyle>;
  name:     string;
}

interface FigmaNode {
  id:       string;
  name:     string;
  type:     string;
  children?: FigmaNode[];
  fills?:   FigmaFill[];
  style?:   FigmaTextStyle;
}

interface FigmaFill {
  type:  string;
  color: { r: number; g: number; b: number; a: number };
}

interface FigmaTextStyle {
  fontFamily:  string;
  fontSize:    number;
  fontWeight:  number;
  lineHeightPx?: number;
  letterSpacing?: number;
}

interface FigmaStyle {
  name:        string;
  styleType:   string;
  description: string;
}

interface FigmaComponentsResponse {
  meta: { components: FigmaComponent[] };
}

interface FigmaComponent {
  key:         string;
  node_id:     string;
  name:        string;
  description: string;
}

const FALLBACK_TOKENS: FigmaDesign = {
  name:       'fallback',
  figmaLink:  '',
  colors:     ['#2c3e50', '#3498db', '#ffffff', '#f5f5f5'],
  spacing:    ['4px', '8px', '16px', '24px', '32px'],
  typography: {
    fontFamily:  'Roboto, sans-serif',
    fontSize:    '16px',
    fontWeight:  '400',
    lineHeight:  '1.5',
  },
  borderRadius: '4px',
  componentKey: '',
};

@Injectable({ providedIn: 'root' })
export class FigmaService {
  private readonly fileUrl  = `https://api.figma.com/v1/files/${environment.figmaFileKey}`;
  private readonly fileKey  = environment.figmaFileKey;

  private get headers(): HttpHeaders {
    return new HttpHeaders({ 'X-Figma-Token': environment.figmaToken });
  }

  constructor(private readonly http: HttpClient) {}

  findBestFrame(frameNameOrStoryContext: string): Observable<FigmaDesign> {
    return this.getAllFrames().pipe(
      switchMap(frames => {
        if (frames.length === 0) return of(FALLBACK_TOKENS);

        const directMatch = this.findDirectMatch(frameNameOrStoryContext, frames);
        if (directMatch) {
          return this.extractDesignTokens(directMatch.id, directMatch.name);
        }

        return this.aiPickFrame(frameNameOrStoryContext, frames).pipe(
          switchMap(picked =>
            picked
              ? this.extractDesignTokens(picked.id, picked.name)
              : of(FALLBACK_TOKENS)
          )
        );
      }),
      catchError(() => of(FALLBACK_TOKENS))
    );
  }

  findComponent(name: string): Observable<FigmaDesign> {
    return this.findBestFrame(name);
  }

  getAllFrames(): Observable<Array<{ id: string; name: string; pageName: string }>> {
    return this.http
      .get<FigmaFileResponse>(this.fileUrl, { headers: this.headers })
      .pipe(
        map(res => {
          const frames: Array<{ id: string; name: string; pageName: string }> = [];
          (res.document.children ?? []).forEach(page => {
            (page.children ?? []).forEach(frame => {
              if (frame.type === 'FRAME' || frame.type === 'COMPONENT') {
                frames.push({
                  id:       frame.id,
                  name:     `${page.name}/${frame.name}`,
                  pageName: page.name,
                });
              }
            });
          });
          return frames;
        }),
        catchError(() => of([] as Array<{ id: string; name: string; pageName: string }>))
      );
  }

  private findDirectMatch(
    input:  string,
    frames: Array<{ id: string; name: string; pageName: string }>
  ): { id: string; name: string } | null {
    const words = input.toLowerCase().split(/[\s\-_/]+/).filter(w => w.length > 2);

    const scored = frames.map(f => ({
      ...f,
      score: words.reduce(
        (acc, word) => acc + (f.name.toLowerCase().includes(word) ? 1 : 0),
        0
      ),
    }));

    const best = scored.sort((a, b) => b.score - a.score)[0];
    if (!best || best.score < Math.ceil(words.length / 2)) return null;
    return { id: best.id, name: best.name };
  }

  private aiPickFrame(
    storyContext: string,
    frames:       Array<{ id: string; name: string; pageName: string }>
  ): Observable<{ id: string; name: string } | null> {
    const frameList = frames.map((f, i) => `${i + 1}. ${f.name}`).join('\n');

    const prompt = `
You are matching a user story to a Figma screen.

Story/component context: "${storyContext}"

Available Figma frames (format: Page/FrameName):
${frameList}

Which frame number best matches the story context?
Return ONLY the number. If nothing matches, return 0.
`.trim();

    return this.callAi(prompt).pipe(
      map(raw => {
        const idx = parseInt(raw.trim(), 10);
        if (!idx || idx < 1 || idx > frames.length) return null;
        const frame = frames[idx - 1];
        return { id: frame.id, name: frame.name };
      }),
      catchError(() => of(null))
    );
  }

  private extractDesignTokens(nodeId: string, frameName: string): Observable<FigmaDesign> {
    return forkJoin({
      node:   this.fetchNode(nodeId),
      styles: this.fetchStyles(),
    }).pipe(
      map(({ node, styles }) => ({
        name:         frameName,
        figmaLink:    `https://figma.com/file/${this.fileKey}?node-id=${encodeURIComponent(nodeId)}`,
        colors:       this.extractColors(node),
        spacing:      this.extractSpacing(node),
        typography:   this.extractTypography(node),
        componentKey: nodeId,
        namedStyles:  Object.values(styles)
          .filter(s => s.styleType === 'FILL' || s.styleType === 'TEXT')
          .map(s => s.name)
          .slice(0, 20),
      } satisfies FigmaDesign & { namedStyles: string[] })),
      catchError(() => of({
        ...FALLBACK_TOKENS,
        name:      frameName,
        figmaLink: `https://figma.com/file/${this.fileKey}?node-id=${encodeURIComponent(nodeId)}`,
      }))
    );
  }

  private fetchNode(nodeId: string): Observable<FigmaNode> {
    const encoded = encodeURIComponent(nodeId);
    return this.http
      .get<{ nodes: Record<string, { document: FigmaNode }> }>(
        `${this.fileUrl}/nodes?ids=${encoded}`,
        { headers: this.headers }
      )
      .pipe(
        map(res => res.nodes[nodeId]?.document ?? { id: nodeId, name: '', type: 'FRAME' }),
        catchError(() => of({ id: nodeId, name: '', type: 'FRAME' } as FigmaNode))
      );
  }

  private fetchStyles(): Observable<Record<string, FigmaStyle>> {
    return this.http
      .get<FigmaComponentsResponse & { meta: { styles: Record<string, FigmaStyle> } }>(
        `${this.fileUrl}/styles`,
        { headers: this.headers }
      )
      .pipe(
        map(res => (res as any)?.meta?.styles ?? {}),
        catchError(() => of({} as Record<string, FigmaStyle>))
      );
  }

  private extractColors(node: FigmaNode): string[] {
    const colors = new Set<string>();
    this.walkNode(node, n => {
      (n.fills ?? []).forEach(fill => {
        if (fill.type === 'SOLID' && fill.color) {
          colors.add(this.rgbToHex(fill.color.r, fill.color.g, fill.color.b));
        }
      });
    });
    return [...colors].slice(0, 10);
  }

  private extractTypography(node: FigmaNode): Record<string, string> {
    const styles: FigmaTextStyle[] = [];
    this.walkNode(node, n => {
      if (n.type === 'TEXT' && n.style) styles.push(n.style);
    });

    if (styles.length === 0) return FALLBACK_TOKENS.typography ?? {};

    const families = styles.map(s => s.fontFamily);
    const topFamily = families.sort(
      (a, b) =>
        families.filter(f => f === b).length - families.filter(f => f === a).length
    )[0];

    const sizes = [...new Set(styles.map(s => `${s.fontSize}px`))].slice(0, 5);

    return {
      fontFamily:  topFamily ?? 'Roboto, sans-serif',
      fontSizes:   sizes.join(', '),
      fontWeights: [...new Set(styles.map(s => String(s.fontWeight)))].join(', '),
    };
  }

  private extractSpacing(_node: FigmaNode): string[] {
    return ['4px', '8px', '12px', '16px', '24px', '32px', '48px', '64px'];
  }

  private walkNode(node: FigmaNode, visitor: (n: FigmaNode) => void): void {
    visitor(node);
    (node.children ?? []).forEach(child => this.walkNode(child, visitor));
  }

  private rgbToHex(r: number, g: number, b: number): string {
    const toHex = (v: number): string =>
      Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  private callAi(prompt: string): Observable<string> {
    const provider = environment.aiProvider ?? 'groq';

    const urlMap: Record<string, string> = {
      anthropic:  '/anthropic-api/v1/messages',
      groq:       'https://api.groq.com/openai/v1/chat/completions',
      openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    };

    const bodyMap: Record<string, object> = {
      anthropic:  { model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: prompt }] },
      groq:       { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 64, temperature: 0 },
      gemini:     { contents: [{ parts: [{ text: prompt }] }] },
      openrouter: { model: 'meta-llama/llama-3.1-8b-instruct:free', messages: [{ role: 'user', content: prompt }] },
    };

    const headersMap: Record<string, HttpHeaders> = {
      anthropic: new HttpHeaders({
        'content-type': 'application/json',
        'x-api-key': environment.anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      }),
      gemini: new HttpHeaders({ 'Content-Type': 'application/json' }),
    };

    const extractMap: Record<string, (res: unknown) => string> = {
      anthropic:  res => (res as any)?.content?.[0]?.text ?? '',
      groq:       res => (res as any)?.choices?.[0]?.message?.content ?? '',
      gemini:     res => (res as any)?.candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      openrouter: res => (res as any)?.choices?.[0]?.message?.content ?? '',
    };

    return this.http
      .post<unknown>(urlMap[provider], bodyMap[provider], { headers: headersMap[provider] })
      .pipe(
        map(res => extractMap[provider](res)),
        catchError(() => of('0'))
      );
  }
}
