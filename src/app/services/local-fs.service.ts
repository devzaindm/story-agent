import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, forkJoin, of, map, catchError } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class LocalFsService {
  private readonly base =
    environment.storyAgentLocalServer ?? 'http://localhost:3001';

  constructor(private readonly http: HttpClient) {}

  listComponents(): Observable<string[]> {
    return this.http
      .get<{ files: string[] }>(`${this.base}/files`)
      .pipe(
        map(res => res.files ?? []),
        catchError(() => of([] as string[]))
      );
  }

  readFile(filePath: string): Observable<string> {
    return this.http
      .get(`${this.base}/file`, { params: { path: filePath }, responseType: 'text' })
      .pipe(catchError(() => of('')));
  }

  readComponentFiles(tsPath: string): Observable<{ ts: string; html: string; scss: string }> {
    return forkJoin({
      ts:   this.readFile(tsPath),
      html: this.readFile(tsPath.replace('.component.ts', '.component.html')),
      scss: this.readFile(tsPath.replace('.component.ts', '.component.scss')),
    });
  }

  writeFile(filePath: string, content: string): Observable<void> {
    return this.http
      .post<void>(`${this.base}/file`, { path: filePath, content })
      .pipe(map(() => void 0));
  }

  writeAll(files: Array<{ path: string; content: string }>): Observable<string[]> {
    if (files.length === 0) return of([]);
    return forkJoin(
      files.map(f =>
        this.writeFile(f.path, f.content).pipe(
          map((): string => f.path),
          catchError(() => of(null as string | null))
        )
      )
    ).pipe(
      map(results => results.filter((p): p is string => p !== null))
    );
  }

  isAvailable(): Observable<boolean> {
    return this.http
      .get(`${this.base}/files`)
      .pipe(
        map(() => true),
        catchError(() => of(false))
      );
  }
}
