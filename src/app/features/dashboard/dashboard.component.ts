import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  inject,
  OnInit,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatButtonModule }          from '@angular/material/button';
import { MatTooltipModule }         from '@angular/material/tooltip';
import { MatIconModule }            from '@angular/material/icon';
import { MatProgressBarModule }     from '@angular/material/progress-bar';

import {
  AzureDashboardService,
  WorkItemSummary,
  SprintStats,
  RecentBuild,
  PullRequestSummary,
} from '../../services/azure-dashboard.service';

@Component({
  selector:        'app-dashboard',
  templateUrl:     './dashboard.component.html',
  styleUrls:       ['./dashboard.component.scss'],
  standalone:      true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    MatProgressSpinnerModule,
    MatButtonModule,
    MatTooltipModule,
    MatIconModule,
    MatProgressBarModule,
  ],
})
export class DashboardComponent implements OnInit {
  private readonly cdr  = inject(ChangeDetectorRef);
  private readonly svc  = inject(AzureDashboardService);

  loading = true;
  error   = '';

  myItems:   WorkItemSummary[]    = [];
  sprint:    SprintStats          = { sprint: null, total: 0, byState: {}, byType: {}, byPriority: {}, items: [] };
  builds:    RecentBuild[]        = [];
  prs:       PullRequestSummary[] = [];
  allActive: WorkItemSummary[]    = [];

  selectedItem: WorkItemSummary | null = null;
  activeTab: 'mine' | 'sprint' | 'prs' | 'builds' = 'mine';

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading = true;
    this.error   = '';
    this.cdr.markForCheck();

    this.svc.loadDashboard().subscribe({
      next: data => {
        this.myItems   = data.myItems;
        this.sprint    = data.sprint;
        this.builds    = data.builds;
        this.prs       = data.prs;
        this.allActive = data.allActive;
        this.loading   = false;
        this.cdr.markForCheck();
      },
      error: err => {
        this.error   = err?.message ?? 'Failed to load dashboard data.';
        this.loading = false;
        this.cdr.markForCheck();
      },
    });
  }

  selectItem(item: WorkItemSummary): void {
    this.selectedItem = this.selectedItem?.id === item.id ? null : item;
    this.cdr.markForCheck();
  }

  setTab(tab: typeof this.activeTab): void {
    this.activeTab = tab;
    this.selectedItem = null;
    this.cdr.markForCheck();
  }

  openInAzure(url: string): void {
    window.open(url, '_blank', 'noopener');
  }

  // ── Derived ────────────────────────────────────────────────────────────

  get currentTabItems(): WorkItemSummary[] {
    if (this.activeTab === 'mine')   return this.myItems;
    if (this.activeTab === 'sprint') return this.sprint.items;
    return [];
  }

  get sprintProgress(): number {
    const done  = (this.sprint.byState['Done'] ?? 0) + (this.sprint.byState['Closed'] ?? 0);
    const total = this.sprint.total;
    return total > 0 ? Math.round((done / total) * 100) : 0;
  }

  get sprintDaysLeft(): number {
    if (!this.sprint.sprint?.endDate) return 0;
    const end  = new Date(this.sprint.sprint.endDate).getTime();
    const now  = Date.now();
    return Math.max(0, Math.ceil((end - now) / 86_400_000));
  }

  get sprintStateEntries(): Array<{ state: string; count: number; pct: number }> {
    const total = this.sprint.total || 1;
    return Object.entries(this.sprint.byState)
      .map(([state, count]) => ({ state, count, pct: Math.round((count / total) * 100) }))
      .sort((a, b) => b.count - a.count);
  }

  get buildSuccessRate(): number {
    if (!this.builds.length) return 0;
    const done    = this.builds.filter(b => b.result === 'succeeded');
    return Math.round((done.length / this.builds.length) * 100);
  }

  stateColor(state: string): string {
    const s = state.toLowerCase();
    if (s === 'done' || s === 'closed' || s === 'resolved') return 'green';
    if (s === 'active' || s === 'in progress')               return 'blue';
    if (s === 'new' || s === 'to do')                        return 'gray';
    if (s === 'removed')                                     return 'red';
    return 'gray';
  }

  typeIcon(type: string): string {
    const t = type.toLowerCase();
    if (t.includes('bug'))          return 'bug_report';
    if (t.includes('user story'))   return 'person';
    if (t.includes('task'))         return 'task_alt';
    if (t.includes('feature'))      return 'star';
    if (t.includes('epic'))         return 'rocket_launch';
    return 'work';
  }

  typeColor(type: string): string {
    const t = type.toLowerCase();
    if (t.includes('bug'))        return 'red';
    if (t.includes('user story')) return 'blue';
    if (t.includes('task'))       return 'yellow';
    if (t.includes('feature'))    return 'purple';
    if (t.includes('epic'))       return 'orange';
    return 'gray';
  }

  priorityLabel(p: number): string {
    return ['', 'Critical', 'High', 'Medium', 'Low'][p] ?? `P${p}`;
  }

  priorityColor(p: number): string {
    return ['', 'red', 'orange', 'yellow', 'green'][p] ?? 'gray';
  }

  buildResultIcon(result: string): string {
    if (result === 'succeeded') return 'check_circle';
    if (result === 'failed')    return 'cancel';
    if (result === 'canceled')  return 'block';
    return 'radio_button_unchecked';
  }

  buildResultColor(result: string): string {
    if (result === 'succeeded') return 'green';
    if (result === 'failed')    return 'red';
    if (result === 'canceled')  return 'gray';
    return 'blue';
  }

  relativeTime(dateStr: string): string {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins  = Math.floor(diff / 60_000);
    const hours = Math.floor(diff / 3_600_000);
    const days  = Math.floor(diff / 86_400_000);
    if (mins  < 1)  return 'just now';
    if (mins  < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days  < 30) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString();
  }

  shortBranch(branch: string): string {
    return branch.length > 35 ? branch.slice(0, 32) + '…' : branch;
  }

  trackById(_: number, item: { id: number }): number {
    return item.id;
  }
}
