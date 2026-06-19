import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadSyncerActionConfig, resolveWorkflowRunOverrides } from '../src/config'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function createYamlWorkspace(config: string) {
  const directory = await mkdtemp(path.join(tmpdir(), 'syncer-action-config-'))
  directories.push(directory)
  await writeFile(path.join(directory, 'syncer-action.config.yml'), config)
  return directory
}

async function createJsonWorkspace(config: unknown) {
  const directory = await mkdtemp(path.join(tmpdir(), 'syncer-action-config-json-'))
  directories.push(directory)
  await writeFile(
    path.join(directory, 'syncer-action.config.json'),
    JSON.stringify(config, null, 2),
  )
  return directory
}

describe('loadSyncerActionConfig', () => {
  it('parses repositories, targets, concurrency, and required secrets', async () => {
    const rootDirectory = await createYamlWorkspace(`azure:
  prefix: release-sync
concurrency:
  workflowMaxParallel: 4
  maxParallelAssets: 3
repositories:
  - owner: openai
    repo: codex
    assetExcludePatterns:
      - "*symbols*"
    targets:
      - name: 123pan-cn
        provider: 123pan
        targetDirectory: /syncer/codex
`)

    const config = loadSyncerActionConfig({
      rootDirectory,
      source: {
        NETDISK_123PAN_CLIENT_ID: 'client-id',
        NETDISK_123PAN_CLIENT_SECRET: 'client-secret',
        AZURE_STORAGE_BLOB_SAS_URL:
          'https://storage.blob.core.windows.net/release-sync?sv=2024-11-04&spr=https&sp=rcwl&sig=test',
      },
    })

    expect(config.repositories).toEqual([
      expect.objectContaining({
        key: 'openai/codex',
        assetExcludePatterns: ['*symbols*'],
        targets: [
          expect.objectContaining({
            name: '123pan-cn',
            targetDirectory: '/syncer/codex',
            maxParallelAssets: 3,
          }),
        ],
      }),
    ])
    expect(config.concurrency).toEqual({ workflowMaxParallel: 4, maxParallelAssets: 3 })
    expect(config.azure).toEqual({
      connectionString: undefined,
      containerName: undefined,
      containerSasUrl:
        'https://storage.blob.core.windows.net/release-sync?sv=2024-11-04&spr=https&sp=rcwl&sig=test',
      prefix: 'release-sync',
    })
    expect(config.requiredSecrets).toEqual([
      'NETDISK_123PAN_CLIENT_ID',
      'NETDISK_123PAN_CLIENT_SECRET',
      'AZURE_STORAGE_BLOB_SAS_URL',
    ])
  })

  it('fails fast when 123pan credentials are missing', async () => {
    const rootDirectory = await createYamlWorkspace(`repositories:
  - owner: openai
    repo: codex
    targetDirectory: /syncer/codex
`)

    expect(() =>
      loadSyncerActionConfig({
        rootDirectory,
        source: {},
      }),
    ).toThrow(/123Pan targets require NETDISK_123PAN_CLIENT_ID, NETDISK_123PAN_CLIENT_SECRET/i)
  })

  it('fails fast when azure metadata credentials are missing', async () => {
    const rootDirectory = await createYamlWorkspace(`repositories:
  - owner: openai
    repo: codex
    targetDirectory: /syncer/codex
`)

    expect(() =>
      loadSyncerActionConfig({
        rootDirectory,
        source: {
          NETDISK_123PAN_CLIENT_ID: 'client-id',
          NETDISK_123PAN_CLIENT_SECRET: 'client-secret',
        },
      }),
    ).toThrow(/AZURE_STORAGE_BLOB_SAS_URL or AZURE_STORAGE_CONNECTION_STRING is required/i)
  })

  it('requires a container name when using connection string mode', async () => {
    const rootDirectory = await createYamlWorkspace(`repositories:
  - owner: openai
    repo: codex
    targetDirectory: /syncer/codex
`)

    expect(() =>
      loadSyncerActionConfig({
        rootDirectory,
        source: {
          NETDISK_123PAN_CLIENT_ID: 'client-id',
          NETDISK_123PAN_CLIENT_SECRET: 'client-secret',
          AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
        },
      }),
    ).toThrow(/AZURE_STORAGE_CONTAINER is required/i)
  })

  it('keeps explicit json config compatibility', async () => {
    const rootDirectory = await createJsonWorkspace({
      azure: {
        prefix: 'release-sync',
      },
      repositories: [
        {
          owner: 'openai',
          repo: 'codex',
          targetDirectory: '/syncer/codex',
        },
      ],
    })

    const config = loadSyncerActionConfig({
      rootDirectory,
      source: {
        NETDISK_123PAN_CLIENT_ID: 'client-id',
        NETDISK_123PAN_CLIENT_SECRET: 'client-secret',
        AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
        AZURE_STORAGE_CONTAINER: 'release-sync',
      },
    })

    expect(config.configFilePath.endsWith('syncer-action.config.json')).toBe(true)
    expect(config.azure).toEqual({
      connectionString: 'UseDevelopmentStorage=true',
      containerName: 'release-sync',
      containerSasUrl: undefined,
      prefix: 'release-sync',
    })
  })
})

describe('resolveWorkflowRunOverrides', () => {
  it('parses repository, target, and dry-run overrides from workflow inputs', () => {
    expect(
      resolveWorkflowRunOverrides({
        INPUT_REPOSITORIES: 'openai/codex, microsoft/PowerToys',
        INPUT_TARGETS: '["123pan"]',
        INPUT_DRY_RUN: 'true',
      }),
    ).toEqual({
      repositoryKeys: ['openai/codex', 'microsoft/PowerToys'],
      targetNames: ['123pan'],
      dryRun: true,
    })
  })
})
