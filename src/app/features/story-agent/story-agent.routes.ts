import { Routes } from '@angular/router';

export const STORY_AGENT_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./story-agent.component').then(m => m.StoryAgentComponent),
  },
];
