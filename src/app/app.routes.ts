import { Routes } from '@angular/router';
import { ShellComponent } from './shell/shell.component';

export const routes: Routes = [
  {
    path: '',
    component: ShellComponent,
    children: [
      { path: '', redirectTo: 'generate', pathMatch: 'full' },
      {
        path: 'generate',
        loadChildren: () =>
          import('./features/story-agent/story-agent.routes').then(m => m.STORY_AGENT_ROUTES),
      },
      {
        path: 'dashboard',
        loadChildren: () =>
          import('./features/dashboard/dashboard.routes').then(m => m.DASHBOARD_ROUTES),
      },
    ],
  },
  { path: '**', redirectTo: 'generate' },
];
