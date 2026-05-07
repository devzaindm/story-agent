import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, of, forkJoin, map, switchMap, catchError, throwError } from 'rxjs';
import { environment } from '../../environments/environment';
import { WorkItemContext, WorkItemFields, WorkItemType } from './ai.service';

interface AzureWorkItemResponse {
  id: number;
  fields: {
    'System.WorkItemType':                           string;
    'System.Title':                                  string;
    'System.Description':                            string;
    'Microsoft.VSTS.Common.AcceptanceCriteria':      string;
    'System.Parent':                                 number | undefined;
    'Custom.FigmaFrame':                             string | undefined;
  };
  relations?: AzureRelation[];
}

interface AzureRelation {
  rel:        string;
  url:        string;
  attributes: { name: string };
}

@Injectable({ providedIn: 'root' })
export class AzureService {
  private readonly baseUrl =
    `https://dev.azure.com/${environment.azureOrg}/${environment.azureProject}/_apis`;

  private get headers(): HttpHeaders {
    return new HttpHeaders({
      'Authorization': `Basic ${btoa(':' + environment.azureToken)}`,
      'Content-Type':  'application/json',
    });
  }

  constructor(private readonly http: HttpClient) {}

  getWorkItemWithContext(id: string): Observable<WorkItemContext> {
    return this.fetchWorkItem(id).pipe(
      switchMap(item => {
        const type      = item.fields['System.WorkItemType'] as WorkItemType;
        const parentId  = item.fields['System.Parent'];
        const taskField = this.mapFields(item);

        if (type === 'User Story' || type === 'Feature' || !parentId) {
          return of<WorkItemContext>({
            type,
            task:        taskField,
            parentStory: null,
            siblings:    [],
          });
        }

        return forkJoin({
          parent:   this.fetchWorkItem(String(parentId)),
          siblings: this.fetchChildTitles(String(parentId), id),
        }).pipe(
          map(({ parent, siblings }) => ({
            type,
            task:        taskField,
            parentStory: this.mapFields(parent),
            siblings,
          } satisfies WorkItemContext))
        );
      }),
      catchError(err =>
        throwError(() => new Error(`AzureService.getWorkItemWithContext: ${err.message}`))
      )
    );
  }

  private fetchWorkItem(id: string): Observable<AzureWorkItemResponse> {
    return this.http
      .get<AzureWorkItemResponse>(
        `${this.baseUrl}/wit/workitems/${id}?$expand=relations&api-version=7.0`,
        { headers: this.headers }
      )
      .pipe(
        catchError(err =>
          throwError(() => new Error(
            `Failed to fetch work item #${id}: ${err?.error?.message ?? err.message}`
          ))
        )
      );
  }

  private fetchChildTitles(
    parentId:      string,
    excludeTaskId: string
  ): Observable<string[]> {
    return this.fetchWorkItem(parentId).pipe(
      switchMap(parent => {
        const childIds = (parent.relations ?? [])
          .filter(r => r.rel === 'System.LinkTypes.Hierarchy-Forward')
          .map(r => r.url.split('/').pop() ?? '')
          .filter(cid => cid && cid !== excludeTaskId);

        if (childIds.length === 0) return of<string[]>([]);

        const ids = childIds.slice(0, 20).join(',');
        return this.http
          .get<{ value: AzureWorkItemResponse[] }>(
            `${this.baseUrl}/wit/workitems?ids=${ids}&fields=System.Title&api-version=7.0`,
            { headers: this.headers }
          )
          .pipe(
            map(res => res.value.map(w => w.fields['System.Title'] ?? '')),
            catchError(() => of<string[]>([]))
          );
      })
    );
  }

  private mapFields(item: AzureWorkItemResponse): WorkItemFields {
    return {
      id:                 item.id,
      title:              item.fields['System.Title']                             ?? '',
      description:        this.stripHtml(item.fields['System.Description']        ?? ''),
      acceptanceCriteria: this.stripHtml(
        item.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] ?? ''
      ),
      figmaFrame:         item.fields['Custom.FigmaFrame'] ?? undefined,
    };
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi,      '\n')
      .replace(/<\/li>/gi,     '\n')
      .replace(/<[^>]+>/g,     '')
      .replace(/&nbsp;/g,      ' ')
      .replace(/&amp;/g,       '&')
      .replace(/&lt;/g,        '<')
      .replace(/&gt;/g,        '>')
      .replace(/&quot;/g,      '"')
      .replace(/\n{3,}/g,      '\n\n')
      .trim();
  }
}
