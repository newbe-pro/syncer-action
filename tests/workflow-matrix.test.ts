import { describe, expect, it } from 'vitest'
import { buildWorkflowMatrix } from '../src/workflow-matrix'
import type { SyncerActionConfig } from '../src/config'

const baseConfig: SyncerActionConfig = {
  rootDirectory: '/workspace',
  configFilePath: '/workspace/syncer-action.config.yml',
  temporaryDirectory: '/workspace/.runtime/release-downloads',
  resultsDirectory: '/workspace/.runtime/results',
  github: {
    apiBaseUrl: 'https://api.github.com',
    token: 'token',
  },
  azure: {
    connectionString: undefined,
    containerName: undefined,
    containerSasUrl: 'https://storage.blob.core.windows.net/release-sync?sv=2024-11-04&spr=https&sp=rcwl&sig=test',
    prefix: 'release-sync',
  },
  concurrency: {
    workflowMaxParallel: 2,
    maxParallelAssets: 2,
  },
  providers: {
    pan123: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: '/workspace/.runtime/123pan-access-token.json',
      errorDetailLevel: 'diagnostic',
    },
  },
  repositories: [
    {
      key: 'openai/codex',
      owner: 'openai',
      repo: 'codex',
      assetExcludePatterns: [],
      targets: [
        {
          name: '123pan',
          provider: '123pan',
          targetDirectory: '/syncer/codex',
          maxParallelAssets: 2,
        },
        {
          name: '123pan-alt',
          provider: '123pan',
          targetDirectory: '/syncer/codex-alt',
          maxParallelAssets: 1,
        },
      ],
    },
    {
      key: 'microsoft/PowerToys',
      owner: 'microsoft',
      repo: 'PowerToys',
      assetExcludePatterns: ['*symbols*'],
      targets: [
        {
          name: '123pan',
          provider: '123pan',
          targetDirectory: '/syncer/powertoys',
          maxParallelAssets: 2,
        },
      ],
    },
  ],
  requiredSecrets: [],
}

describe('buildWorkflowMatrix', () => {
  it('builds deterministic repository-target matrix items', () => {
    expect(buildWorkflowMatrix(baseConfig, { dryRun: false })).toEqual([
      expect.objectContaining({
        repositoryKey: 'microsoft/PowerToys',
        targetName: '123pan',
      }),
      expect.objectContaining({
        repositoryKey: 'openai/codex',
        targetName: '123pan',
      }),
      expect.objectContaining({
        repositoryKey: 'openai/codex',
        targetName: '123pan-alt',
      }),
    ])
  })

  it('applies repository and target filters plus dry-run overrides', () => {
    expect(
      buildWorkflowMatrix(baseConfig, {
        repositoryKeys: ['openai/codex'],
        targetNames: ['123pan-alt'],
        dryRun: true,
      }),
    ).toEqual([
      expect.objectContaining({
        repositoryKey: 'openai/codex',
        targetName: '123pan-alt',
        dryRun: true,
      }),
    ])
  })
})
