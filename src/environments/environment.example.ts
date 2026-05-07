// Copy this file to environment.ts and fill in your values.
// NEVER commit environment.ts — it contains real API keys.
export const environment = {
  production: false,
  aiProvider: 'anthropic',                    // 'anthropic' | 'gemini' | 'groq'
  anthropicApiKey: 'sk-ant-api03-YOUR_KEY',
  azureToken: 'YOUR_AZURE_DEVOPS_PAT',
  azureOrg: 'YOUR_ORG',
  azureProject: 'YOUR_PROJECT',
  azureRepo: 'YOUR_REPO',
  figmaToken: 'figd_YOUR_FIGMA_TOKEN',
  figmaFileKey: 'YOUR_FIGMA_FILE_KEY',
  revampTargetBranch: 'your-target-branch',
  storyAgentLocalServer: 'http://localhost:3001',
  geminiApiKey: '',
  groqApiKey: '',
};
