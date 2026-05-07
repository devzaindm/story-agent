import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, forkJoin, of, map, catchError, switchMap } from 'rxjs';
import { environment } from '../../environments/environment';

// ─── Models ───────────────────────────────────────────────────────────────────

export type WorkItemState =
  | 'New' | 'Active' | 'Resolved' | 'Closed' | 'Done'
  | 'In Progress' | 'To Do' | 'Removed' | string;

export interface WorkItemSummary {
  id:           number;
  title:        string;
  state:        WorkItemState;
  type:         string;
  assignedTo:   string;
  assignedAvatar: string;
  priority:     number;
  storyPoints:  number | null;
  tags:         string[];
  iterationPath: string;
  areaPath:     string;
  createdDate:  string;
  changedDate:  string;
  parentId:     number | null;
  description:  string;
  url:          string;
}

export interface SprintInfo {
  id:        string;
  name:      string;
  startDate: string;
  endDate:   string;
  path:      string;
}

export interface SprintStats {
  sprint:      SprintInfo | null;
  total:       number;
  byState:     Record<string, number>;
  byType:      Record<string, number>;
  byPriority:  Record<number, number>;
  items:       WorkItemSummary[];
}

export interface RecentBuild {
  id:           number;
  buildNumber:  string;
  status:       string;
  result:       string;
  definition:   string;
  branch:       string;
  startTime:    string;
  finishTime:   string;
  requestedBy:  string;
  webUrl:       string;
}

export interface PullRequestSummary {
  id:           number;
  title:        string;
  status:       string;
  createdBy:    string;
  sourceBranch: string;
  targetBranch: string;
  creationDate: string;
  url:          string;
  isDraft:      boolean;
  reviewers:    string[];
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class AzureDashboardService {
  private readonly org     = environment.azureOrg;
  private readonly project = environment.azureProject;
  private readonly repo    = environment.azureRepo;
  private readonly base    = `https://dev.azure.com/${this.org}/${this.project}/_apis`;
  private readonly repoBase = `https://dev.azure.com/${this.org}/${this.project}/_apis/git/repositories/${this.repo}`;

  private get headers(): HttpHeaders {
    return new HttpHeaders({
      'Authorization': `Basic ${btoa(':' + environment.azureToken)}`,
      'Content-Type':  'application/json',
    });
  }

  constructor(private readonly http: HttpClient) {}

  // ── Full dashboard data in one call ─────────────────────────────────────

  loadDashboard(): Observable<{
    myItems:    WorkItemSummary[];
    sprint:     SprintStats;
    builds:     RecentBuild[];
    prs:        PullRequestSummary[];
    allActive:  WorkItemSummary[];
  }> {
    return forkJoin({
      myItems:   this.getMyWorkItems(),
      sprint:    this.getCurrentSprintStats(),
      builds:    this.getRecentBuilds(8),
      prs:       this.getOpenPullRequests(),
      allActive: this.getActiveWorkItems(),
    }).pipe(
      catchError(err => {
        console.error('Dashboard load error:', err);
        return of({ myItems: [], sprint: this.emptySprint(), builds: [], prs: [], allActive: [] });
      })
    );
  }

  // ── My assigned work items (not done) ────────────────────────────────────

  getMyWorkItems(): Observable<WorkItemSummary[]> {
    const wiql = {
      query: `SELECT [System.Id] FROM WorkItems
              WHERE [System.AssignedTo] = @Me
              AND [System.State] NOT IN ('Done','Closed','Removed')
              ORDER BY [System.ChangedDate] DESC`,
    };

    return this.runWiql(wiql).pipe(
      switchMap(ids => ids.length ? this.fetchWorkItemDetails(ids.slice(0, 50)) : of([]))
    );
  }

  // ── All active items in current sprint ───────────────────────────────────

  getCurrentSprintStats(): Observable<SprintStats> {
    return this.getCurrentSprint().pipe(
      switchMap(sprint => {
        if (!sprint) return of(this.emptySprint());

        const wiql = {
          query: `SELECT [System.Id] FROM WorkItems
                  WHERE [System.IterationPath] = '${sprint.path}'
                  AND [System.State] NOT IN ('Removed')
                  ORDER BY [System.WorkItemType], [System.State]`,
        };

        return this.runWiql(wiql).pipe(
          switchMap(ids =>
            ids.length
              ? this.fetchWorkItemDetails(ids.slice(0, 100))
              : of([] as WorkItemSummary[])
          ),
          map(items => this.buildSprintStats(sprint, items))
        );
      }),
      catchError(() => of(this.emptySprint()))
    );
  }

  // ── All active work items across all sprints ──────────────────────────────

  getActiveWorkItems(): Observable<WorkItemSummary[]> {
    const wiql = {
      query: `SELECT [System.Id] FROM WorkItems
              WHERE [System.TeamProject] = '${this.project}'
              AND [System.State] IN ('Active','In Progress','New','To Do')
              ORDER BY [System.ChangedDate] DESC`,
    };

    return this.runWiql(wiql).pipe(
      switchMap(ids => ids.length ? this.fetchWorkItemDetails(ids.slice(0, 30)) : of([]))
    );
  }

  // ── Recent builds ─────────────────────────────────────────────────────────

  getRecentBuilds(top = 8): Observable<RecentBuild[]> {
    return this.http
      .get<any>(
        `${this.base}/build/builds?$top=${top}&queryOrder=queueTimeDescending&api-version=7.0`,
        { headers: this.headers }
      )
      .pipe(
        map(res => (res.value ?? []).map((b: any) => ({
          id:          b.id,
          buildNumber: b.buildNumber ?? '',
          status:      b.status      ?? '',
          result:      b.result      ?? 'none',
          definition:  b.definition?.name ?? '',
          branch:      (b.sourceBranch ?? '').replace('refs/heads/', ''),
          startTime:   b.startTime   ?? '',
          finishTime:  b.finishTime  ?? '',
          requestedBy: b.requestedBy?.displayName ?? '',
          webUrl:      b._links?.web?.href ?? '',
        } as RecentBuild))),
        catchError(() => of([] as RecentBuild[]))
      );
  }

  // ── Open PRs ──────────────────────────────────────────────────────────────

  getOpenPullRequests(): Observable<PullRequestSummary[]> {
    return this.http
      .get<any>(
        `${this.repoBase}/pullrequests?searchCriteria.status=active&$top=20&api-version=7.0`,
        { headers: this.headers }
      )
      .pipe(
        map(res => (res.value ?? []).map((pr: any) => ({
          id:           pr.pullRequestId,
          title:        pr.title                             ?? '',
          status:       pr.status                           ?? '',
          createdBy:    pr.createdBy?.displayName           ?? '',
          sourceBranch: (pr.sourceRefName ?? '').replace('refs/heads/', ''),
          targetBranch: (pr.targetRefName ?? '').replace('refs/heads/', ''),
          creationDate: pr.creationDate                     ?? '',
          url:          `https://dev.azure.com/${this.org}/${this.project}/_git/${this.repo}/pullrequest/${pr.pullRequestId}`,
          isDraft:      pr.isDraft                          ?? false,
          reviewers:    (pr.reviewers ?? []).map((r: any) => r.displayName ?? ''),
        } as PullRequestSummary))),
        catchError(() => of([] as PullRequestSummary[]))
      );
  }

  // ── Get single work item full detail ──────────────────────────────────────

  getWorkItemDetail(id: number): Observable<WorkItemSummary> {
    return this.http
      .get<any>(
        `${this.base}/wit/workitems/${id}?$expand=all&api-version=7.0`,
        { headers: this.headers }
      )
      .pipe(
        map(item => this.mapWorkItem(item)),
        catchError(() => of(null as any))
      );
  }

  // ── WIQL query → array of IDs ─────────────────────────────────────────────

  private runWiql(query: object): Observable<number[]> {
    return this.http
      .post<any>(
        `${this.base}/wit/wiql?api-version=7.0`,
        query,
        { headers: this.headers }
      )
      .pipe(
        map(res => (res.workItems ?? []).map((w: any) => w.id as number)),
        catchError(() => of([] as number[]))
      );
  }

  // ── Batch-fetch work item details ─────────────────────────────────────────

  private fetchWorkItemDetails(ids: number[]): Observable<WorkItemSummary[]> {
    if (ids.length === 0) return of([]);

    const fields = [
      'System.Id', 'System.Title', 'System.State', 'System.WorkItemType',
      'System.AssignedTo', 'System.AreaPath', 'System.IterationPath',
      'System.Description', 'System.Tags', 'System.CreatedDate', 'System.ChangedDate',
      'Microsoft.VSTS.Common.Priority', 'Microsoft.VSTS.Scheduling.StoryPoints',
      'System.Parent',
    ].join(',');

    const idParam = ids.join(',');

    return this.http
      .get<any>(
        `${this.base}/wit/workitems?ids=${idParam}&fields=${fields}&api-version=7.0`,
        { headers: this.headers }
      )
      .pipe(
        map(res => (res.value ?? []).map((item: any) => this.mapWorkItem(item))),
        catchError(() => of([] as WorkItemSummary[]))
      );
  }

  // ── Current sprint ────────────────────────────────────────────────────────

  private getCurrentSprint(): Observable<SprintInfo | null> {
    return this.http
      .get<any>(
        `${this.base}/work/teamsettings/iterations?$timeframe=current&api-version=7.0`,
        { headers: this.headers }
      )
      .pipe(
        map(res => {
          const it = res.value?.[0];
          if (!it) return null;
          return {
            id:        it.id,
            name:      it.name,
            startDate: it.attributes?.startDate ?? '',
            endDate:   it.attributes?.finishDate ?? '',
            path:      it.path,
          } as SprintInfo;
        }),
        catchError(() => of(null))
      );
  }

  // ── Map raw Azure work item → WorkItemSummary ────────────────────────────

  private mapWorkItem(item: any): WorkItemSummary {
    const f = item.fields ?? {};
    const assignedTo = f['System.AssignedTo'];
    return {
      id:             item.id,
      title:          f['System.Title']                              ?? '',
      state:          f['System.State']                             ?? '',
      type:           f['System.WorkItemType']                      ?? '',
      assignedTo:     typeof assignedTo === 'object'
                        ? assignedTo?.displayName ?? ''
                        : assignedTo ?? '',
      assignedAvatar: typeof assignedTo === 'object'
                        ? assignedTo?.imageUrl ?? ''
                        : '',
      priority:       f['Microsoft.VSTS.Common.Priority']          ?? 4,
      storyPoints:    f['Microsoft.VSTS.Scheduling.StoryPoints']   ?? null,
      tags:           (f['System.Tags'] ?? '').split(';').map((t: string) => t.trim()).filter(Boolean),
      iterationPath:  f['System.IterationPath']                    ?? '',
      areaPath:       f['System.AreaPath']                         ?? '',
      createdDate:    f['System.CreatedDate']                      ?? '',
      changedDate:    f['System.ChangedDate']                      ?? '',
      parentId:       f['System.Parent']                           ?? null,
      description:    this.stripHtml(f['System.Description']       ?? ''),
      url:            `https://dev.azure.com/${this.org}/${this.project}/_workitems/edit/${item.id}`,
    };
  }

  private buildSprintStats(sprint: SprintInfo, items: WorkItemSummary[]): SprintStats {
    const byState:    Record<string, number> = {};
    const byType:     Record<string, number> = {};
    const byPriority: Record<number, number> = {};

    for (const item of items) {
      byState[item.state]       = (byState[item.state]       ?? 0) + 1;
      byType[item.type]         = (byType[item.type]         ?? 0) + 1;
      byPriority[item.priority] = (byPriority[item.priority] ?? 0) + 1;
    }

    return { sprint, total: items.length, byState, byType, byPriority, items };
  }

  private emptySprint(): SprintStats {
    return { sprint: null, total: 0, byState: {}, byType: {}, byPriority: {}, items: [] };
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi,   '\n')
      .replace(/<[^>]+>/g,  '')
      .replace(/&nbsp;/g,   ' ')
      .replace(/&amp;/g,    '&')
      .replace(/&lt;/g,     '<')
      .replace(/&gt;/g,     '>')
      .replace(/\n{3,}/g,   '\n\n')
      .trim();
  }
}
