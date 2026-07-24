import { describe, expect, it } from 'vitest'
import {
  buildReleaseSyncManifestBlobName,
  buildReleaseSyncManifestIndexBlobName,
  createReleaseSyncMetadataStore,
  logicalPathToAssetName,
  resolveLatestDraftRelease,
  type DrafterReleaseGitHubClient,
  type ReleaseAssetRef,
} from '../../src/metadata/drafter-release-manifest-store'
import type {
  ReleaseSyncManifest,
  ReleaseSyncManifestIndex,
  ReleaseSyncRecord,
} from '../../src/release-sync-contracts'

function createRecord(overrides: Partial<ReleaseSyncRecord> = {}): ReleaseSyncRecord {
  return {
    repositoryKey: 'openai/codex',
    releaseId: 101,
    releaseTagName: 'v1.0.0',
    assetId: 201,
    assetName: 'app.zip',
    assetSize: 12,
    assetUpdatedAt: '2026-04-10T07:00:00.000Z',
    sourceDownloadUrl: 'https://example.com/app.zip',
    sha256: 'abc',
    providerName: '123pan',
    remoteFileId: 'file-1',
    shareUrl: 'https://share.example/file-1',
    status: 'synced',
    firstSyncedAt: '2026-04-10T08:00:00.000Z',
    lastSyncedAt: '2026-04-10T08:00:00.000Z',
    lastAttemptedAt: '2026-04-10T08:00:00.000Z',
    failureStage: null,
    failureMessage: null,
    ...overrides,
  }
}

class InMemoryDrafterClient implements DrafterReleaseGitHubClient {
  releases: Array<{
    id: number
    tag_name: string
    draft: boolean
    created_at: string
    html_url?: string
  }>
  private readonly assetsByRelease = new Map<number, Map<string, ReleaseAssetRef & { body: string }>>()
  private nextAssetId = 1
  failUploadFor: string | null = null

  constructor(
    releases: Array<{
      id: number
      tag_name: string
      draft: boolean
      created_at: string
      html_url?: string
    }> = [
      {
        id: 55,
        tag_name: 'vNext',
        draft: true,
        created_at: '2026-04-10T00:00:00.000Z',
      },
    ],
  ) {
    this.releases = releases
  }

  async listReleases() {
    return this.releases
  }

  async listReleaseAssets(releaseId: number) {
    const assets = this.assetsByRelease.get(releaseId)
    return assets ? [...assets.values()].map(({ body: _body, ...asset }) => asset) : []
  }

  async downloadAsset(asset: ReleaseAssetRef) {
    for (const assets of this.assetsByRelease.values()) {
      const found = assets.get(asset.name)
      if (found && found.id === asset.id) {
        return found.body
      }
    }
    const error = new Error('Not Found') as Error & { status: number; statusCode: number }
    error.status = 404
    error.statusCode = 404
    throw error
  }

  async deleteAsset(assetId: number) {
    for (const assets of this.assetsByRelease.values()) {
      for (const [name, asset] of assets.entries()) {
        if (asset.id === assetId) {
          assets.delete(name)
          return
        }
      }
    }
  }

  async uploadReleaseAsset(releaseId: number, assetName: string, body: Buffer | string) {
    if (this.failUploadFor === assetName) {
      throw new Error(`upload failed for ${assetName}`)
    }

    let assets = this.assetsByRelease.get(releaseId)
    if (!assets) {
      assets = new Map()
      this.assetsByRelease.set(releaseId, assets)
    }

    const id = this.nextAssetId
    this.nextAssetId += 1
    const payload = typeof body === 'string' ? body : body.toString('utf8')
    const asset: ReleaseAssetRef & { body: string } = {
      id,
      name: assetName,
      size: Buffer.byteLength(payload),
      url: `https://api.github.com/assets/${id}`,
      updatedAt: `2026-04-10T08:00:${String(id).padStart(2, '0')}.000Z`,
      body: payload,
    }
    assets.set(assetName, asset)
    const { body: _body, ...publicAsset } = asset
    return publicAsset
  }

  readJson<T>(releaseId: number, logicalPath: string): T | undefined {
    const assets = this.assetsByRelease.get(releaseId)
    const asset = assets?.get(logicalPathToAssetName(logicalPath))
    return asset ? (JSON.parse(asset.body) as T) : undefined
  }
}

describe('logicalPathToAssetName', () => {
  it('flattens logical paths with a stable delimiter', () => {
    expect(logicalPathToAssetName('release-sync/index.json')).toBe('release-sync__index.json')
    expect(logicalPathToAssetName('release-sync/owner/repo/manifest.json')).toBe(
      'release-sync__owner__repo__manifest.json',
    )
  })

  it('rejects unsafe path segments', () => {
    expect(() => logicalPathToAssetName('release-sync/../secret')).toThrow(/Unsafe path segment/)
  })
})

describe('buildReleaseSyncManifestBlobName', () => {
  it('uses one file per repository, not per release tag', () => {
    expect(buildReleaseSyncManifestBlobName('openai/codex', 'release-sync', 'v1.0.0')).toBe(
      'release-sync/openai/codex/manifest.json',
    )
    expect(buildReleaseSyncManifestBlobName('openai/codex', 'release-sync', 'v2.0.0')).toBe(
      'release-sync/openai/codex/manifest.json',
    )
  })
})

describe('resolveLatestDraftRelease', () => {
  it('selects the draft with the latest created_at', async () => {
    const client = new InMemoryDrafterClient([
      {
        id: 1,
        tag_name: 'old',
        draft: true,
        created_at: '2026-04-01T00:00:00.000Z',
      },
      {
        id: 2,
        tag_name: 'published',
        draft: false,
        created_at: '2026-04-11T00:00:00.000Z',
      },
      {
        id: 3,
        tag_name: 'newest-draft',
        draft: true,
        created_at: '2026-04-10T00:00:00.000Z',
      },
    ])

    await expect(resolveLatestDraftRelease(client)).resolves.toMatchObject({
      id: 3,
      tagName: 'newest-draft',
    })
  })

  it('fails when no draft release exists', async () => {
    const client = new InMemoryDrafterClient([
      {
        id: 2,
        tag_name: 'published',
        draft: false,
        created_at: '2026-04-11T00:00:00.000Z',
      },
    ])

    await expect(resolveLatestDraftRelease(client, { owner: 'acme', repo: 'syncer' })).rejects.toThrow(
      /No draft \(drafter\) release found in acme\/syncer/,
    )
  })
})

describe('createDrafterReleaseManifestStore', () => {
  it('returns empty manifest and index when assets are missing', async () => {
    const client = new InMemoryDrafterClient()
    const store = createReleaseSyncMetadataStore({
      owner: 'acme',
      repo: 'syncer',
      client,
      now: () => new Date('2026-04-10T08:00:00.000Z'),
    })

    await expect(store.loadManifest('openai/codex', 'v1.0.0')).resolves.toMatchObject({
      repositoryKey: 'openai/codex',
      releaseTagName: 'v1.0.0',
      records: [],
      blobPath: 'release-sync/openai/codex/manifest.json',
    })
    await expect(store.loadManifestIndex()).resolves.toMatchObject({
      repositories: [],
      blobPath: 'release-sync/index.json',
    })
  })

  it('fails load when no draft release exists', async () => {
    const client = new InMemoryDrafterClient([])
    const store = createReleaseSyncMetadataStore({
      owner: 'acme',
      repo: 'syncer',
      client,
      now: () => new Date('2026-04-10T08:00:00.000Z'),
    })

    await expect(store.loadManifest('openai/codex', 'v1.0.0')).rejects.toThrow(/No draft \(drafter\) release/)
  })

  it('saves one repository manifest asset and upserts the root index', async () => {
    const client = new InMemoryDrafterClient()
    const store = createReleaseSyncMetadataStore({
      owner: 'acme',
      repo: 'syncer',
      prefix: 'release-sync',
      client,
      now: () => new Date('2026-04-10T08:00:00.000Z'),
    })

    const saved = await store.saveManifest({
      repositoryKey: 'openai/codex',
      releaseTagName: 'v1.0.0',
      version: 1,
      updatedAt: '2026-04-09T00:00:00.000Z',
      records: [createRecord()],
    })

    expect(saved.blobPath).toBe('release-sync/openai/codex/manifest.json')
    expect(saved.updatedAt).toBe('2026-04-10T08:00:00.000Z')

    const manifestAssetName = logicalPathToAssetName(saved.blobPath!)
    const indexAssetName = logicalPathToAssetName(buildReleaseSyncManifestIndexBlobName('release-sync'))
    const assets = await client.listReleaseAssets(55)
    expect(assets.map((asset) => asset.name).sort()).toEqual([indexAssetName, manifestAssetName].sort())

    const loaded = await store.loadManifest('openai/codex', 'v1.0.0')
    expect(loaded.records).toHaveLength(1)
    expect(loaded.records[0]?.assetName).toBe('app.zip')

    const index = await store.loadManifestIndex()
    expect(index.repositories).toEqual([
      expect.objectContaining({
        repositoryKey: 'openai/codex',
        releaseTagName: 'v1.0.0',
        manifestPath: 'release-sync/openai/codex/manifest.json',
        recordCount: 1,
        status: 'synced',
      }),
    ])
  })

  it('keeps multiple release tags in the same repository asset', async () => {
    const client = new InMemoryDrafterClient()
    const store = createReleaseSyncMetadataStore({
      owner: 'acme',
      repo: 'syncer',
      client,
      now: () => new Date('2026-04-10T08:00:00.000Z'),
    })

    await store.saveManifest({
      repositoryKey: 'openai/codex',
      releaseTagName: 'v1.0.0',
      version: 1,
      updatedAt: '2026-04-09T00:00:00.000Z',
      records: [
        createRecord({ assetName: 'old.zip', releaseTagName: 'v1.0.0', assetId: 1 }),
        createRecord({
          assetName: 'new.zip',
          releaseTagName: 'v2.0.0',
          assetId: 2,
          releaseId: 102,
        }),
      ],
    })

    const loaded = await store.loadManifest('openai/codex')
    expect(loaded.blobPath).toBe('release-sync/openai/codex/manifest.json')
    expect(loaded.records.map((record) => record.releaseTagName).sort()).toEqual(['v1.0.0', 'v2.0.0'])

    const assets = await client.listReleaseAssets(55)
    const manifestAssets = assets.filter((asset) => asset.name.includes('manifest.json'))
    expect(manifestAssets).toHaveLength(1)
    expect(manifestAssets[0]?.name).toBe('release-sync__openai__codex__manifest.json')

    const index = await store.loadManifestIndex()
    const repo = index.repositories.find((entry) => entry.repositoryKey === 'openai/codex')
    expect(repo?.releases.map((release) => release.releaseTagName).sort()).toEqual(['v1.0.0', 'v2.0.0'])
    expect(repo?.releases.every((release) => release.manifestPath === 'release-sync/openai/codex/manifest.json')).toBe(
      true,
    )
  })

  it('replaces the same repository asset on save', async () => {
    const client = new InMemoryDrafterClient()
    const store = createReleaseSyncMetadataStore({
      owner: 'acme',
      repo: 'syncer',
      client,
      now: () => new Date('2026-04-10T08:00:00.000Z'),
    })

    await store.saveManifest({
      repositoryKey: 'openai/codex',
      releaseTagName: 'v1.0.0',
      version: 1,
      updatedAt: '2026-04-09T00:00:00.000Z',
      records: [createRecord({ assetName: 'first.zip', assetId: 1 })],
    })

    await store.saveManifest({
      repositoryKey: 'openai/codex',
      releaseTagName: 'v1.0.0',
      version: 1,
      updatedAt: '2026-04-09T00:00:00.000Z',
      records: [createRecord({ assetName: 'second.zip', assetId: 2 })],
    })

    const loaded = await store.loadManifest('openai/codex', 'v1.0.0')
    expect(loaded.records).toEqual([expect.objectContaining({ assetName: 'second.zip' })])

    const assets = await client.listReleaseAssets(55)
    const manifestAssets = assets.filter((asset) => asset.name.includes('manifest.json'))
    expect(manifestAssets).toHaveLength(1)
  })

  it('requires releaseTagName when saving', async () => {
    const client = new InMemoryDrafterClient()
    const store = createReleaseSyncMetadataStore({
      owner: 'acme',
      repo: 'syncer',
      client,
      now: () => new Date('2026-04-10T08:00:00.000Z'),
    })

    await expect(
      store.saveManifest({
        repositoryKey: 'openai/codex',
        releaseTagName: null,
        version: 1,
        updatedAt: '2026-04-09T00:00:00.000Z',
        records: [],
      }),
    ).rejects.toThrow(/releaseTagName is required/)
  })

  it('throws MetadataPublicationError with manifestPersisted when index refresh fails', async () => {
    const client = new InMemoryDrafterClient()
    const indexAssetName = logicalPathToAssetName(buildReleaseSyncManifestIndexBlobName('release-sync'))
    client.failUploadFor = indexAssetName

    const store = createReleaseSyncMetadataStore({
      owner: 'acme',
      repo: 'syncer',
      client,
      now: () => new Date('2026-04-10T08:00:00.000Z'),
    })

    const manifestPath = buildReleaseSyncManifestBlobName('openai/codex', 'release-sync', 'v1.0.0')

    await expect(
      store.saveManifest({
        repositoryKey: 'openai/codex',
        releaseTagName: 'v1.0.0',
        version: 1,
        updatedAt: '2026-04-09T00:00:00.000Z',
        records: [createRecord()],
      }),
    ).rejects.toMatchObject({
      name: 'MetadataPublicationError',
      details: {
        repositoryKey: 'openai/codex',
        manifestPersisted: true,
        manifestPath,
        rootIndexPath: 'release-sync/index.json',
      },
    })

    const persisted = client.readJson<ReleaseSyncManifest>(55, manifestPath)
    expect(persisted?.records[0]?.assetName).toBe('app.zip')
  })

  it('keeps deterministic repository upsert ordering in the root index', async () => {
    const client = new InMemoryDrafterClient()
    let tick = 0
    const store = createReleaseSyncMetadataStore({
      owner: 'acme',
      repo: 'syncer',
      client,
      now: () => new Date(`2026-04-10T08:00:${String(tick++).padStart(2, '0')}.000Z`),
    })

    await store.saveManifest({
      repositoryKey: 'zeta/app',
      releaseTagName: 'v1.0.0',
      version: 1,
      updatedAt: '2026-04-09T00:00:00.000Z',
      records: [createRecord({ repositoryKey: 'zeta/app', assetName: 'z.zip' })],
    })
    await store.saveManifest({
      repositoryKey: 'alpha/app',
      releaseTagName: 'v1.0.0',
      version: 1,
      updatedAt: '2026-04-09T00:00:00.000Z',
      records: [createRecord({ repositoryKey: 'alpha/app', assetName: 'a.zip' })],
    })

    const index = client.readJson<ReleaseSyncManifestIndex>(55, 'release-sync/index.json')
    expect(index?.repositories.map((entry) => entry.repositoryKey)).toEqual([
      'alpha/app',
      'zeta/app',
    ])
  })
})
