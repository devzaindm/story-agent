# Story Agent

An AI-powered developer tool that reads an Azure DevOps work item and automatically generates production-ready Angular components — complete with TypeScript, HTML, SCSS, and a spec file — then commits the files to a new branch and opens a draft Pull Request, all in a single click.

---

## Overview

Story Agent bridges the gap between a ticket description and working code. A developer pastes a work item ID, the pipeline fetches the full context from Azure DevOps (title, description, acceptance criteria, parent story, sibling tasks), reasons about what needs to be built, pulls matching design tokens from Figma, generates the component via the Claude AI API, validates the output, and either saves the files locally or creates a PR directly on the target branch — without the developer ever leaving the browser.

---

## How It Works

```
Azure DevOps Work Item
        │
        ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. FETCH & PARSE                                                    │
│     AzureService → fetch work item + parent story + sibling tasks   │
│     AiService    → detectIntent (new_component / revamp / bug_fix…) │
│     AiService    → parseWorkItem → structured requirements           │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  2. SCAN & DESIGN                                                    │
│     CodebaseScannerService → locate existing component in repo       │
│     FigmaService           → find matching frame, extract tokens     │
│                              (colors, spacing, typography)           │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  3. GENERATE & VALIDATE                                              │
│     AiService → dispatch to correct generator based on intent:      │
│       • generateNewComponent   (new_component / new_module)         │
│       • revampComponent        (revamp_component)                   │
│       • partialUpdate          (partial_update)                     │
│       • fixBug                 (bug_fix)                            │
│       • updateStyles           (style_only)                         │
│       • generateService        (new_service)                        │
│     AiService → validateOutput → check for issues / suggestions     │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  4. SAVE / PR                                                        │
│     Option A — Save locally: LocalFsService → write via port 3001   │
│     Option B — Create PR:    PrService → create branch, commit      │
│                               files, open draft PR on Azure DevOps  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Angular 21 (standalone components, lazy loading) |
| UI Library | Angular Material 18 (dark theme, MDC) |
| Language | TypeScript 5 |
| Styling | SCSS with CSS custom properties |
| State / reactivity | RxJS 7 — `forkJoin`, `switchMap`, `takeUntilDestroyed` |
| AI / code generation | [Anthropic Claude API](https://www.anthropic.com/) (`claude-sonnet-4-5`) |
| Work item source | Azure DevOps REST API v7.0 |
| Design tokens | Figma REST API |
| Local file I/O | Node.js HTTP server (`story-agent-server.js`, port 3001) |
| Dev proxy | Angular proxy config → `api.anthropic.com` |
| Build tooling | Angular CLI 21, esbuild |

---

## Features

- **Intent detection** — AI classifies the work item as one of 7 intents (`new_component`, `revamp_component`, `partial_update`, `bug_fix`, `style_only`, `new_service`, `new_module`) and routes to the appropriate generator
- **Codebase scanner** — scans the target repository for an existing component matching the work item, with a confidence score; falls back to Azure Git API when local server is unavailable
- **Figma integration** — automatically finds the best matching frame in the Figma file and extracts design tokens (colors, spacing, typography) to feed into generation prompts
- **Code preview** — tabbed editor-style viewer for the generated `.ts`, `.html`, `.scss`, and `.spec.ts` files before committing anything
- **Save locally** — writes generated files directly into the target project via the local file server
- **Draft PR** — creates a feature branch, commits all generated files, and opens a Draft Pull Request on Azure DevOps in one step
- **Azure DevOps Dashboard** — real-time view of your assigned work items, active sprint progress, recent build statuses, and open pull requests

---

## Project Structure

```
story-agent/
├── src/
│   ├── app/
│   │   ├── features/
│   │   │   ├── story-agent/          # Generate page (main pipeline UI)
│   │   │   │   ├── story-agent.component.ts
│   │   │   │   ├── story-agent.component.html
│   │   │   │   ├── story-agent.component.scss
│   │   │   │   └── story-agent.routes.ts
│   │   │   └── dashboard/            # Azure DevOps dashboard
│   │   │       ├── dashboard.component.ts
│   │   │       ├── dashboard.component.html
│   │   │       ├── dashboard.component.scss
│   │   │       └── dashboard.routes.ts
│   │   ├── services/
│   │   │   ├── pipeline.service.ts       # Orchestrates the full pipeline
│   │   │   ├── ai.service.ts             # All Claude API calls
│   │   │   ├── azure.service.ts          # Work item fetching
│   │   │   ├── azure-dashboard.service.ts# Dashboard data (WIQL, builds, PRs)
│   │   │   ├── figma.service.ts          # Figma frame + token extraction
│   │   │   ├── scanner.service.ts        # Codebase component scanner
│   │   │   ├── pr.service.ts             # Branch creation + PR opening
│   │   │   └── local-fs.service.ts       # localhost:3001 file I/O
│   │   ├── shell/                        # App shell (sidebar + router-outlet)
│   │   ├── app.routes.ts
│   │   ├── app.config.ts
│   │   └── app.ts
│   ├── environments/
│   │   ├── environment.example.ts    # ← copy this to environment.ts
│   │   └── environment.ts            # ← not committed (contains secrets)
│   ├── index.html
│   ├── main.ts
│   └── styles.scss
├── story-agent-server.js             # Node.js local file server
├── proxy.conf.json                   # Dev proxy for Anthropic API
├── angular.json
└── package.json
```

---

## Services

### `PipelineService`
Orchestrates the end-to-end flow. Exposes three methods:
- `prepare(workItemId, onStatus$)` — runs steps 1–3, returns a `PrepareResult` for review
- `submit(prepared, onStatus$)` — runs step 4a (create PR on Azure DevOps)
- `writeLocally(prepared, onStatus$)` — runs step 4b (save files via local server)

### `AiService`
All interactions with the Anthropic Claude API. Key methods:
- `detectIntent(context)` — classifies the work item
- `parseWorkItem(context, intent)` — extracts structured requirements
- `generateNewComponent(req, design)` — generates a complete Angular component
- `revampComponent(req, existing, design)` — rewrites an existing component
- `partialUpdate / fixBug / updateStyles / generateService` — intent-specific generators
- `validateOutput(output, req)` — checks the generated code for issues
- `generatePRDescription(context, output, validation)` — writes the PR body

### `AzureService`
Fetches work items from Azure DevOps, including parent User Story and sibling tasks for context enrichment.

### `FigmaService`
Queries the Figma REST API to find the best-matching frame for a work item, then extracts design tokens (color styles, text styles, spacing values) to include in AI prompts.

### `CodebaseScannerService`
Locates the relevant existing component in the target repository. First attempts the local file server, falls back to the Azure Git API. Returns a match with a confidence score and a reason string.

### `PrService`
Creates a new feature branch off the target branch, commits all generated files as a single push, and opens a Draft Pull Request on Azure DevOps.

### `AzureDashboardService`
Powers the Dashboard tab using Azure DevOps REST APIs:
- Work items assigned to `@Me` (WIQL query)
- Current sprint stats (state breakdown, type breakdown, completion %)
- Recent build runs with status and duration
- Open pull requests for the configured repository

---

## Prerequisites

- Node.js 20+
- Angular CLI 21: `npm install -g @angular/cli`
- A GitHub CLI or `gh` (optional, for deployment)
- Access to:
  - Azure DevOps organization with a Personal Access Token (PAT)
  - Anthropic API key
  - Figma API token + file key

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp src/environments/environment.example.ts src/environments/environment.ts
```

Edit `src/environments/environment.ts` and fill in your credentials:

```typescript
export const environment = {
  production: false,
  aiProvider: 'anthropic',
  anthropicApiKey: 'sk-ant-api03-...',     // Anthropic Console → API Keys
  azureToken: '...',                        // Azure DevOps → User Settings → PAT
  azureOrg: 'your-org',                    // Azure DevOps organization name
  azureProject: 'your-project',            // Azure DevOps project name
  azureRepo: 'your-repo',                  // Git repository name
  figmaToken: 'figd_...',                  // Figma → Account Settings → Access Tokens
  figmaFileKey: '...',                     // From the Figma file URL
  revampTargetBranch: 'your-base-branch',  // Branch to target for PRs
  storyAgentLocalServer: 'http://localhost:3001',
};
```

### 3. Start the local file server

The file server allows Story Agent to read and write files in your target Angular project:

```bash
node story-agent-server.js
```

> Edit the `PROJECT_ROOT` constant in `story-agent-server.js` to point to your target project directory.

The server runs on `http://localhost:3001` and exposes:
- `GET  /files` — lists all `.component.ts` paths under `/src`
- `GET  /file?path=...` — reads a file (path relative to project root)
- `POST /file {path, content}` — writes a file into the project

### 4. Start the dev server

```bash
ng serve
```

Open `http://localhost:4200`. The app uses an Angular proxy to forward `/anthropic-api/*` requests to `https://api.anthropic.com`, so no CORS issues during development.

---

## Usage

1. Navigate to **Generate** in the sidebar
2. Enter an Azure DevOps work item ID (e.g. `10007`)
3. Click **Run Pipeline** — watch the log as it fetches, scans, designs, and generates
4. Review the generated code in the tabbed preview (`.ts`, `.html`, `.scss`, `.spec.ts`)
5. Check the summary strip: intent, component name, target branch, scanner confidence
6. Choose an action:
   - **Save to Project** — writes files directly to your local project via the file server
   - **Create PR** — creates a feature branch and opens a Draft PR on Azure DevOps
   - **Download** — downloads all generated files as individual downloads

---

## Azure DevOps Permissions Required (PAT)

The PAT configured in `environment.ts` needs the following scopes:

| Scope | Required for |
|---|---|
| Work Items — Read | Fetching work item context |
| Code — Read & Write | Reading existing components, committing generated files |
| Pull Requests — Read & Write | Creating draft PRs |
| Build — Read | Dashboard build status |

---

## Security Notes

- `src/environments/environment.ts` is in `.gitignore` and will never be committed
- The local file server (`localhost:3001`) is development-only; it binds only to `localhost` and validates all file paths against the project root to prevent path traversal
- The Angular dev proxy strips the `/anthropic-api` prefix before forwarding — your API key travels only as an `x-api-key` header in the proxied request, never exposed in the browser network tab as a full URL

---

## License

MIT
