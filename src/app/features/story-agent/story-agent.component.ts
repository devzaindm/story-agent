import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  inject,
  OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { MatButtonModule }          from '@angular/material/button';
import { MatInputModule }           from '@angular/material/input';
import { MatFormFieldModule }       from '@angular/material/form-field';
import { MatProgressBarModule }     from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule }            from '@angular/material/icon';
import { MatChipsModule }           from '@angular/material/chips';
import { MatTooltipModule }         from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatBadgeModule }           from '@angular/material/badge';
import { MatRippleModule }          from '@angular/material/core';

import {
  PipelineService,
  PipelineResult,
  PrepareResult,
  LocalWriteResult,
} from '../../services/pipeline.service';
import { GeneratedOutput } from '../../services/ai.service';

type AgentState = 'idle' | 'preparing' | 'confirm' | 'saving' | 'saved' | 'submitting' | 'done';
type CodeTab    = 'ts' | 'html' | 'scss' | 'spec';

@Component({
  selector:        'app-story-agent',
  templateUrl:     './story-agent.component.html',
  styleUrls:       ['./story-agent.component.scss'],
  standalone:      true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatInputModule,
    MatFormFieldModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatChipsModule,
    MatTooltipModule,
    MatSnackBarModule,
    MatBadgeModule,
    MatRippleModule,
  ],
})
export class StoryAgentComponent implements OnInit {

  storyId           = '';
  manualTsPath      = '';
  showPathOverride  = false;

  state:            AgentState  = 'idle';
  statusMessages:   string[]    = [];
  prUrl             = '';
  error             = '';
  pendingResult:    PrepareResult | null   = null;
  pipelineResult:   PipelineResult | null  = null;
  localWriteResult: LocalWriteResult | null = null;
  selectedTab:      CodeTab     = 'ts';

  private readonly destroyRef = inject(DestroyRef);
  private readonly snackBar   = inject(MatSnackBar);
  private readonly cdr        = inject(ChangeDetectorRef);

  constructor(private readonly pipeline: PipelineService) {}

  ngOnInit(): void {}

  // ── Derived ────────────────────────────────────────────────────────────────

  get running(): boolean {
    return this.state === 'preparing' || this.state === 'submitting' || this.state === 'saving';
  }

  get componentName(): string {
    return this.pendingResult?.requirements?.componentName ?? '';
  }

  get output(): GeneratedOutput | null {
    return this.pendingResult?.output ?? null;
  }

  get activeCode(): string {
    const out = this.output;
    if (!out) return '';
    const map: Record<CodeTab, string> = {
      ts:   out.componentTs,
      html: out.componentHtml,
      scss: out.componentScss,
      spec: out.specTs,
    };
    return map[this.selectedTab] ?? '';
  }

  get branchName(): string {
    const taskId = this.pendingResult?.context?.task?.id ?? this.storyId.trim();
    const kebab  = this.componentName
      .replace(/([A-Z])/g, '-$1')
      .toLowerCase()
      .replace(/^-/, '');
    return `agent/task-${taskId}-${kebab}`;
  }

  get resolvedTsPath(): string {
    return this.manualTsPath.trim() || this.pendingResult?.locationResult?.resolvedPaths?.ts || '';
  }

  get scannerConfidence(): number {
    return this.pendingResult?.locationResult?.location?.confidence ?? 0;
  }

  get scannerReason(): string {
    return this.pendingResult?.locationResult?.location?.reason ?? '';
  }

  get scannerFoundExisting(): boolean {
    return this.pendingResult?.locationResult?.found ?? false;
  }

  get validationIssues(): string[] {
    return this.pendingResult?.validation?.issues ?? [];
  }

  get validationPassed(): boolean {
    return this.pendingResult?.validation?.passed ?? false;
  }

  get intent(): string {
    return this.pendingResult?.intent ?? '';
  }

  get confidencePercent(): number {
    return Math.round(this.scannerConfidence * 100);
  }

  get confidenceColor(): string {
    if (this.scannerConfidence >= 0.8) return 'success';
    if (this.scannerConfidence >= 0.5) return 'warning';
    return 'danger';
  }

  get stageIndex(): number {
    const map: Record<AgentState, number> = {
      idle: 0, preparing: 1, confirm: 2, saving: 2,
      saved: 3, submitting: 3, done: 4,
    };
    return map[this.state] ?? 0;
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  run(): void {
    if (!this.storyId.trim() || this.running) return;

    this.statusMessages   = [];
    this.prUrl            = '';
    this.error            = '';
    this.pendingResult    = null;
    this.pipelineResult   = null;
    this.manualTsPath     = '';
    this.showPathOverride = false;
    this.selectedTab      = 'ts';
    this.state            = 'preparing';

    this.pipeline
      .prepare(this.storyId.trim(), msg => {
        this.statusMessages.push(msg);
        this.cdr.markForCheck();
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result: PrepareResult) => {
          this.pendingResult = result;
          this.state         = 'confirm';
          this.cdr.markForCheck();
        },
        error: err => {
          this.error = err?.message ?? 'Pipeline failed. Check console for details.';
          this.state = 'idle';
          this.cdr.markForCheck();
        },
      });
  }

  confirm(): void {
    if ((this.state !== 'confirm' && this.state !== 'saved') || !this.pendingResult) return;

    this.applyManualPathOverride();
    this.state = 'submitting';
    this.cdr.markForCheck();

    this.pipeline
      .submit(this.pendingResult, msg => {
        this.statusMessages.push(msg);
        this.cdr.markForCheck();
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result: PipelineResult) => {
          this.pipelineResult = result;
          this.prUrl          = result.prUrl;
          this.state          = 'done';
          this.cdr.markForCheck();
        },
        error: err => {
          this.error = err?.message ?? 'PR creation failed.';
          this.state = 'confirm';
          this.cdr.markForCheck();
        },
      });
  }

  saveLocally(): void {
    if (this.state !== 'confirm' && this.state !== 'saved') return;
    if (!this.pendingResult) return;

    this.applyManualPathOverride();
    this.state = 'saving';
    this.cdr.markForCheck();

    this.pipeline
      .writeLocally(this.pendingResult, msg => {
        this.statusMessages.push(msg);
        this.cdr.markForCheck();
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result: LocalWriteResult) => {
          this.localWriteResult = result;
          this.state            = 'saved';
          this.cdr.markForCheck();
        },
        error: err => {
          this.error = err?.message ?? 'Write failed. Is story-agent-server.js running?';
          this.state = 'confirm';
          this.cdr.markForCheck();
        },
      });
  }

  cancel(): void {
    this.statusMessages   = [];
    this.pendingResult    = null;
    this.pipelineResult   = null;
    this.localWriteResult = null;
    this.error            = '';
    this.manualTsPath     = '';
    this.showPathOverride = false;
    this.state            = 'idle';
    this.cdr.markForCheck();
  }

  reset(): void {
    this.cancel();
    this.prUrl   = '';
    this.storyId = '';
  }

  private applyManualPathOverride(): void {
    if (this.manualTsPath.trim() && this.pendingResult?.locationResult?.resolvedPaths) {
      const base = this.manualTsPath.trim().replace('.component.ts', '');
      this.pendingResult.locationResult.resolvedPaths = {
        ts:   `${base}.component.ts`,
        html: `${base}.component.html`,
        scss: `${base}.component.scss`,
        spec: `${base}.component.spec.ts`,
      };
    }
  }

  selectTab(tab: CodeTab): void {
    this.selectedTab = tab;
    this.cdr.markForCheck();
  }

  togglePathOverride(): void {
    this.showPathOverride = !this.showPathOverride;
    if (this.showPathOverride && !this.manualTsPath) {
      this.manualTsPath = this.pendingResult?.locationResult?.resolvedPaths?.ts ?? '';
    }
    this.cdr.markForCheck();
  }

  copyBranchName(): void {
    navigator.clipboard.writeText(this.branchName).then(() => {
      this.snackBar.open('Branch name copied', '', { duration: 2000 });
    });
  }

  copyFilePath(): void {
    navigator.clipboard.writeText(this.resolvedTsPath).then(() => {
      this.snackBar.open('File path copied', '', { duration: 2000 });
    });
  }

  copyActiveCode(): void {
    navigator.clipboard.writeText(this.activeCode).then(() => {
      this.snackBar.open('Code copied to clipboard', '', { duration: 2000 });
    });
  }

  downloadAll(): void {
    const out   = this.output;
    const paths = this.pendingResult?.locationResult?.resolvedPaths;
    if (!out || !paths) return;

    const files = [
      { path: paths.ts,   content: out.componentTs   },
      { path: paths.html, content: out.componentHtml },
      { path: paths.scss, content: out.componentScss },
      { path: paths.spec, content: out.specTs        },
    ].filter(f => f.content?.trim());

    for (const file of files) {
      const name = file.path.split('/').pop() ?? file.path;
      const blob = new Blob([file.content], { type: 'text/plain' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  readonly tabs: Array<{ key: CodeTab; label: string; icon: string; ext: string }> = [
    { key: 'ts',   label: 'TypeScript', icon: 'code',     ext: '.ts'   },
    { key: 'html', label: 'Template',   icon: 'html',     ext: '.html' },
    { key: 'scss', label: 'Styles',     icon: 'brush',    ext: '.scss' },
    { key: 'spec', label: 'Tests',      icon: 'science',  ext: '.spec' },
  ];

  intentLabel(intent: string): string {
    const map: Record<string, string> = {
      new_component:    'New Component',
      revamp_component: 'Revamp',
      partial_update:   'Partial Update',
      bug_fix:          'Bug Fix',
      new_service:      'New Service',
      new_module:       'New Module',
      style_only:       'Style Update',
    };
    return map[intent] ?? intent;
  }

  intentIcon(intent: string): string {
    const map: Record<string, string> = {
      new_component:    'add_box',
      revamp_component: 'auto_fix_high',
      partial_update:   'edit',
      bug_fix:          'bug_report',
      new_service:      'settings',
      new_module:       'dashboard',
      style_only:       'palette',
    };
    return map[intent] ?? 'code';
  }
}
