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
    const rootDirectory = await createYamlWorkspace(`metadataStorage:
  prefix: release-sync
  releaseSelector: latest-draft
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
        GITHUB_TOKEN: 'gh-token',
        GITHUB_REPOSITORY: 'acme/syncer-action',
      },
    })

    expect(config.repositories).toEqual([
      expect.objectContaining({
        key: 'openai/codex',
        assetExcludePatterns: ['*symbols*'],
        targets: [
          expect.objectContaining({
            name: '123pan-cn',
            provider: '123pan',
            targetDirectory: '/syncer/codex',
            maxParallelAssets: 3,
          }),
        ],
      }),
    ])
    expect(config.concurrency).toEqual({
      workflowMaxParallel: 4,
      maxParallelAssets: 3,
    })
    expect(config.metadataStorage).toEqual({
      owner: 'acme',
      repo: 'syncer-action',
      prefix: 'release-sync',
      releaseSelector: 'latest-draft',
    })
    expect(config.requiredSecrets).toEqual([
      'NETDISK_123PAN_CLIENT_ID',
      'NETDISK_123PAN_CLIENT_SECRET',
    ])
  })

  it('defaults metadataStorage prefix and releaseSelector', async () => {
    const rootDirectory = await createYamlWorkspace(`repositories:
  - owner: openai
    repo: codex
    targetDirectory: /syncer/codex
`)

    const config = loadSyncerActionConfig({
      rootDirectory,
      source: {
        NETDISK_123PAN_CLIENT_ID: 'client-id',
        NETDISK_123PAN_CLIENT_SECRET: 'client-secret',
        GITHUB_TOKEN: 'gh-token',
        GITHUB_REPOSITORY: 'acme/syncer-action',
      },
    })

    expect(config.metadataStorage).toEqual({
      owner: 'acme',
      repo: 'syncer-action',
      prefix: 'release-sync',
      releaseSelector: 'latest-draft',
    })
  })

  it('uses explicit metadataStorage owner/repo over GITHUB_REPOSITORY', async () => {
    const rootDirectory = await createYamlWorkspace(`metadataStorage:
  owner: other
  repo: meta-store
  prefix: custom-prefix
repositories:
  - owner: openai
    repo: codex
    targetDirectory: /syncer/codex
`)

    const config = loadSyncerActionConfig({
      rootDirectory,
      source: {
        NETDISK_123PAN_CLIENT_ID: 'client-id',
        NETDISK_123PAN_CLIENT_SECRET: 'client-secret',
        GITHUB_TOKEN: 'gh-token',
        GITHUB_REPOSITORY: 'acme/syncer-action',
      },
    })

    expect(config.metadataStorage).toEqual({
      owner: 'other',
      repo: 'meta-store',
      prefix: 'custom-prefix',
      releaseSelector: 'latest-draft',
    })
  })

  it('requires 123Pan credentials when 123pan targets are configured', async () => {
    const rootDirectory = await createYamlWorkspace(`repositories:
  - owner: openai
    repo: codex
    targetDirectory: /syncer/codex
`)

    expect(() =>
      loadSyncerActionConfig({
        rootDirectory,
        source: {
          GITHUB_TOKEN: 'gh-token',
          GITHUB_REPOSITORY: 'acme/syncer-action',
        },
      }),
    ).toThrow(/NETDISK_123PAN_CLIENT_ID/)
  })

  it('accepts JSON config as a compatibility fallback', async () => {
    const rootDirectory = await createJsonWorkspace({
      metadataStorage: { prefix: 'release-sync' },
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
        GITHUB_TOKEN: 'gh-token',
        GITHUB_REPOSITORY: 'acme/syncer-action',
      },
    })

    expect(config.repositories[0]?.key).toBe('openai/codex')
    expect(config.metadataStorage.prefix).toBe('release-sync')
  })
})

describe('resolveWorkflowRunOverrides', () => {
  it('parses repository and target filters from env', () => {
    const overrides = resolveWorkflowRunOverrides({
      SYNCER_ACTION_REPOSITORIES: 'openai/codex,microsoft/PowerToys',
      SYNCER_ACTION_TARGETS: '123pan',
      SYNCER_ACTION_DRY_RUN: 'true',
    })

    expect(overrides).toEqual({
      repositoryKeys: ['openai/codex', 'microsoft/PowerToys'],
      targetNames: ['123pan'],
      dryRun: true,
    })
  })
})
