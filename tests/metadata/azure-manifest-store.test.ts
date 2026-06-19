import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  buildReleaseSyncManifestIndexBlobName,
  buildReleaseSyncManifestBlobName,
  createAzureBlobContainerClient,
  createReleaseSyncMetadataStore,
} from '../../src/metadata/azure-manifest-store'
import type { ReleaseSyncManifest, ReleaseSyncRecord } from '../../src/release-sync-contracts'

const validSasUrl =
  'https://storage.blob.core.windows.net/release-sync?sv=2024-11-04&spr=https&sp=rcwl&sig=test'

class InMemoryContainerClient {
  private readonly blobs = new Map<string, { body: string; etag: string; lastModified: Date }>()
  private etagCounter = 0

  async createIfNotExists() {}

  readBlob(blobName: string) {
    return this.blobs.get(blobName)?.body
  }

  readJson<T>(blobName: string): T | undefined {
    const body = this.readBlob(blobName)
    return body ? (JSON.parse(body) as T) : undefined
  }

  async *listBlobsFlat(options?: { prefix?: string }) {
    for (const [name, blob] of this.blobs.entries()) {
      if (options?.prefix && !name.startsWith(options.prefix)) {
        continue
      }

      yield {
        name,
        properties: {
          lastModified: blob.lastModified,
        },
      }
    }
  }

  getBlockBlobClient(blobName: string) {
    return {
      download: async () => {
        const blob = this.blobs.get(blobName)
        if (!blob) {
          const error = new Error('Blob not found') as Error & { statusCode: number }
          error.statusCode = 404
          throw error
        }

        return {
          etag: blob.etag,
          readableStreamBody: Readable.from([blob.body]),
        }
      },
      uploadData: async (data: Uint8Array) => {
        this.etagCounter += 1
        const etag = `etag-${this.etagCounter}`
        this.blobs.set(blobName, {
          body: Buffer.from(data).toString('utf8'),
          etag,
          lastModified: new Date(
            `2026-04-09T10:05:${String(this.etagCounter).padStart(2, '0')}.000Z`,
          ),
        })

        return { etag }
      },
    }
  }
}

class FailingRootIndexUploadContainerClient extends InMemoryContainerClient {
  constructor(
    private readonly indexBlobName: string,
    private readonly error: Error & { code?: string; statusCode?: number },
  ) {
    super()
  }

  override getBlockBlobClient(blobName: string) {
    const client = super.getBlockBlobClient(blobName)
    if (blobName !== this.indexBlobName) {
      return client
    }

    return {
      ...client,
      uploadData: async () => {
        throw this.error
      },
    }
  }
}

class ThrowingContainerClient {
  public createIfNotExistsCalls = 0

  constructor(private readonly error: Error & { code?: string; statusCode?: number }) {}

  async createIfNotExists() {
    this.createIfNotExistsCalls += 1
    throw this.error
  }

  async *listBlobsFlat() {
    yield {
      name: 'release-sync/openai/codex/v1.0.0/manifest.json',
      properties: {
        lastModified: new Date('2026-04-09T10:00:00.000Z'),
      },
    }
  }

  getBlockBlobClient(_blobName: string) {
    return {
      download: async () => {
        throw this.error
      },
      uploadData: async () => {
        throw this.error
      },
    }
  }
}

function createManifestRecord(overrides: Partial<ReleaseSyncRecord> = {}): ReleaseSyncRecord {
  return {
    repositoryKey: overrides.repositoryKey ?? 'openai/codex',
    releaseId: overrides.releaseId ?? 1,
    releaseTagName: overrides.releaseTagName ?? 'v1.0.0',
    assetId: overrides.assetId ?? 2,
    assetName: overrides.assetName ?? 'codex-linux-x64.zip',
    assetSize: overrides.assetSize ?? 128,
    assetUpdatedAt: overrides.assetUpdatedAt ?? '2026-04-09T09:55:00.000Z',
    sourceDownloadUrl:
      overrides.sourceDownloadUrl ??
      'https://github.com/openai/codex/releases/download/v1.0.0/linux.zip',
    sha256: overrides.sha256 ?? 'abc123',
    providerName: overrides.providerName ?? 'mock',
    remoteFileId: overrides.remoteFileId ?? 'mock-123',
    shareUrl: overrides.shareUrl ?? 'https://mock.example.com/share/mock-123',
    status: overrides.status ?? 'synced',
    firstSyncedAt: overrides.firstSyncedAt ?? '2026-04-09T10:00:00.000Z',
    lastSyncedAt: overrides.lastSyncedAt ?? '2026-04-09T10:00:00.000Z',
    lastAttemptedAt: overrides.lastAttemptedAt ?? '2026-04-09T10:00:00.000Z',
    failureStage: overrides.failureStage ?? null,
    failureMessage: overrides.failureMessage ?? null,
    failureDiagnostics: overrides.failureDiagnostics ?? null,
  }
}

function createManifest(overrides: Partial<ReleaseSyncManifest> = {}): ReleaseSyncManifest {
  return {
    repositoryKey: overrides.repositoryKey ?? 'openai/codex',
    releaseTagName: overrides.releaseTagName ?? 'v1.0.0',
    version: overrides.version ?? 1,
    updatedAt: overrides.updatedAt ?? '2026-04-09T10:00:00.000Z',
    records: overrides.records ?? [createManifestRecord()],
    etag: overrides.etag,
    blobPath: overrides.blobPath,
  }
}

describe('createReleaseSyncMetadataStore', () => {
  it('returns an empty manifest when the repository blob does not exist', async () => {
    const store = createReleaseSyncMetadataStore({
      prefix: 'release-sync',
      now: () => new Date('2026-04-09T10:00:00.000Z'),
      containerClient: new InMemoryContainerClient(),
    })

    await expect(store.loadManifest('openai/codex')).resolves.toEqual({
      repositoryKey: 'openai/codex',
      releaseTagName: null,
      version: 1,
      updatedAt: '2026-04-09T10:00:00.000Z',
      records: [],
      blobPath: 'release-sync/openai/codex/<release-tag>/manifest.json',
    })
  })

  it('returns an empty root manifest index when index.json does not exist', async () => {
    const store = createReleaseSyncMetadataStore({
      prefix: 'release-sync',
      now: () => new Date('2026-04-09T10:00:00.000Z'),
      containerClient: new InMemoryContainerClient(),
    })

    await expect(store.loadManifestIndex()).resolves.toEqual({
      version: 1,
      updatedAt: '2026-04-09T10:00:00.000Z',
      repositories: [],
      blobPath: 'release-sync/index.json',
    })
  })

  it('persists and reloads repository manifests from the configured versioned blob path', async () => {
    const containerClient = new InMemoryContainerClient()
    const store = createReleaseSyncMetadataStore({
      prefix: 'custom-prefix',
      now: () => new Date('2026-04-09T10:05:00.000Z'),
      containerClient,
    })

    const manifest = await store.saveManifest({
      repositoryKey: 'openai/codex',
      releaseTagName: 'v1.0.0',
      version: 1,
      updatedAt: '2026-04-09T10:00:00.000Z',
      records: [createManifestRecord()],
    })

    expect(buildReleaseSyncManifestBlobName('openai/codex', 'custom-prefix', 'v1.0.0')).toBe(
      'custom-prefix/openai/codex/v1.0.0/manifest.json',
    )
    expect(manifest.etag).toBe('etag-1')

    await expect(store.loadManifest('openai/codex', 'v1.0.0')).resolves.toEqual({
      repositoryKey: 'openai/codex',
      releaseTagName: 'v1.0.0',
      version: 1,
      updatedAt: '2026-04-09T10:05:00.000Z',
      records: manifest.records,
      etag: 'etag-1',
      blobPath: 'custom-prefix/openai/codex/v1.0.0/manifest.json',
    })
  })

  it('creates the root index on the first successful manifest write', async () => {
    const containerClient = new InMemoryContainerClient()
    const store = createReleaseSyncMetadataStore({
      prefix: 'custom-prefix',
      now: () => new Date('2026-04-09T10:05:00.000Z'),
      containerClient,
    })

    await store.saveManifest(
      createManifest({
        repositoryKey: 'openai/codex',
        releaseTagName: 'v1.0.0',
        records: [createManifestRecord()],
      }),
    )

    const indexBlobName = buildReleaseSyncManifestIndexBlobName('custom-prefix')
    expect(containerClient.readJson(indexBlobName)).toMatchObject({
      version: 1,
      updatedAt: '2026-04-09T10:05:00.000Z',
      repositories: [
        {
          repositoryKey: 'openai/codex',
          owner: 'openai',
          repo: 'codex',
          displayName: 'openai/codex',
          releaseTagName: 'v1.0.0',
          manifestPath: 'custom-prefix/openai/codex/v1.0.0/manifest.json',
          recordCount: 1,
          updatedAt: '2026-04-09T10:05:00.000Z',
          lastAttemptedAt: '2026-04-09T10:00:00.000Z',
          lastSuccessfulAt: '2026-04-09T10:00:00.000Z',
          status: 'synced',
          releases: [
            {
              releaseTagName: 'v1.0.0',
              manifestPath: 'custom-prefix/openai/codex/v1.0.0/manifest.json',
              status: 'synced',
            },
          ],
        },
      ],
    })
  })

  it('loads the most recently updated versioned manifest when no release tag is provided', async () => {
    const containerClient = new InMemoryContainerClient()
    const store = createReleaseSyncMetadataStore({
      prefix: 'custom-prefix',
      now: () => new Date('2026-04-09T10:05:00.000Z'),
      containerClient,
    })

    await store.saveManifest({
      repositoryKey: 'openai/codex',
      releaseTagName: 'v1.0.0',
      version: 1,
      updatedAt: '2026-04-09T10:00:00.000Z',
      records: [],
    })
    await store.saveManifest({
      repositoryKey: 'openai/codex',
      releaseTagName: 'v1.1.0',
      version: 1,
      updatedAt: '2026-04-09T10:01:00.000Z',
      records: [],
    })

    await expect(store.loadManifest('openai/codex')).resolves.toEqual({
      repositoryKey: 'openai/codex',
      releaseTagName: 'v1.1.0',
      version: 1,
      updatedAt: '2026-04-09T10:05:00.000Z',
      records: [],
      etag: 'etag-3',
      blobPath: 'custom-prefix/openai/codex/v1.1.0/manifest.json',
    })
  })

  it('replaces the prior release summary for the same release while preserving other releases', async () => {
    const store = createReleaseSyncMetadataStore({
      prefix: 'custom-prefix',
      now: () => new Date('2026-04-09T10:05:00.000Z'),
      containerClient: new InMemoryContainerClient(),
    })

    await store.saveManifest(
      createManifest({
        releaseTagName: 'v1.0.0',
        records: [
          createManifestRecord({
            releaseTagName: 'v1.0.0',
            lastAttemptedAt: '2026-04-09T10:00:00.000Z',
            lastSyncedAt: '2026-04-09T10:00:00.000Z',
          }),
        ],
      }),
    )
    await store.saveManifest(
      createManifest({
        releaseTagName: 'v1.1.0',
        records: [
          createManifestRecord({
            releaseId: 2,
            releaseTagName: 'v1.1.0',
            sourceDownloadUrl:
              'https://github.com/openai/codex/releases/download/v1.1.0/linux.zip',
            lastAttemptedAt: '2026-04-09T11:00:00.000Z',
            lastSyncedAt: '2026-04-09T11:00:00.000Z',
          }),
        ],
      }),
    )
    await store.saveManifest(
      createManifest({
        releaseTagName: 'v1.0.0',
        records: [
          createManifestRecord({
            releaseTagName: 'v1.0.0',
            assetSize: 256,
            sha256: 'def456',
            remoteFileId: 'mock-456',
            shareUrl: 'https://mock.example.com/share/mock-456',
            lastAttemptedAt: '2026-04-09T12:00:00.000Z',
            lastSyncedAt: '2026-04-09T12:00:00.000Z',
          }),
        ],
      }),
    )

    const index = await store.loadManifestIndex()
    const repository = index.repositories[0]!
    expect(index.repositories).toHaveLength(1)
    expect(repository).toMatchObject({
      repositoryKey: 'openai/codex',
      releaseTagName: 'v1.0.0',
      manifestPath: 'custom-prefix/openai/codex/v1.0.0/manifest.json',
      status: 'synced',
    })
    expect(repository.releases).toHaveLength(2)
    expect(repository.releases).toEqual([
      expect.objectContaining({
        releaseTagName: 'v1.0.0',
        recordCount: 1,
        status: 'synced',
        manifestPath: 'custom-prefix/openai/codex/v1.0.0/manifest.json',
        lastAttemptedAt: '2026-04-09T12:00:00.000Z',
        lastSuccessfulAt: '2026-04-09T12:00:00.000Z',
      }),
      expect.objectContaining({
        releaseTagName: 'v1.1.0',
        manifestPath: 'custom-prefix/openai/codex/v1.1.0/manifest.json',
      }),
    ])
  })

  it('keeps repositories and release lists deterministically ordered and maps empty manifests to awaiting evidence', async () => {
    const store = createReleaseSyncMetadataStore({
      prefix: 'custom-prefix',
      now: () => new Date('2026-04-09T10:05:00.000Z'),
      containerClient: new InMemoryContainerClient(),
    })

    await store.saveManifest(
      createManifest({
        repositoryKey: 'zeta/repo',
        releaseTagName: 'v2.0.0',
        records: [],
      }),
    )
    await store.saveManifest(
      createManifest({
        repositoryKey: 'alpha/repo',
        releaseTagName: 'v2.0.0',
        records: [
          createManifestRecord({
            repositoryKey: 'alpha/repo',
            releaseTagName: 'v2.0.0',
            sourceDownloadUrl: 'https://github.com/alpha/repo/releases/download/v2.0.0/linux.zip',
          }),
        ],
      }),
    )
    await store.saveManifest(
      createManifest({
        repositoryKey: 'alpha/repo',
        releaseTagName: 'v1.0.0',
        records: [
          createManifestRecord({
            repositoryKey: 'alpha/repo',
            releaseId: 3,
            releaseTagName: 'v1.0.0',
            sourceDownloadUrl: 'https://github.com/alpha/repo/releases/download/v1.0.0/linux.zip',
            lastAttemptedAt: '2026-04-08T09:00:00.000Z',
            lastSyncedAt: '2026-04-08T09:00:00.000Z',
          }),
        ],
      }),
    )

    const index = await store.loadManifestIndex()
    const firstRepository = index.repositories[0]!
    const secondRepository = index.repositories[1]!
    expect(index.repositories.map((repository) => repository.repositoryKey)).toEqual([
      'alpha/repo',
      'zeta/repo',
    ])
    expect(firstRepository.releases.map((release) => release.releaseTagName)).toEqual([
      'v1.0.0',
      'v2.0.0',
    ])
    expect(secondRepository).toMatchObject({
      repositoryKey: 'zeta/repo',
      releaseTagName: 'v2.0.0',
      status: 'awaiting_evidence',
      lastAttemptedAt: null,
      lastSuccessfulAt: null,
    })
    expect(secondRepository.releases[0]!).toMatchObject({
      releaseTagName: 'v2.0.0',
      status: 'awaiting_evidence',
      lastAttemptedAt: null,
      lastSuccessfulAt: null,
    })
  })

  it('maps release summaries from the latest attempted record while preserving the latest successful timestamp', async () => {
    const store = createReleaseSyncMetadataStore({
      prefix: 'custom-prefix',
      now: () => new Date('2026-04-09T10:05:00.000Z'),
      containerClient: new InMemoryContainerClient(),
    })

    await store.saveManifest(
      createManifest({
        releaseTagName: 'v1.0.0',
        records: [
          createManifestRecord({
            releaseTagName: 'v1.0.0',
            lastAttemptedAt: '2026-04-09T10:00:00.000Z',
            lastSyncedAt: '2026-04-09T10:00:00.000Z',
            status: 'synced',
          }),
          createManifestRecord({
            releaseTagName: 'v1.0.0',
            releaseId: 2,
            assetId: 3,
            assetName: 'codex-arm64.zip',
            sourceDownloadUrl: 'https://github.com/openai/codex/releases/download/v1.0.0/arm64.zip',
            status: 'upload_failed',
            lastAttemptedAt: '2026-04-09T11:00:00.000Z',
            lastSyncedAt: null,
            firstSyncedAt: null,
            failureStage: 'upload',
            failureMessage: 'upload failed',
          }),
        ],
      }),
    )
    await store.saveManifest(
      createManifest({
        releaseTagName: 'v2.0.0',
        records: [
          createManifestRecord({
            releaseId: 3,
            releaseTagName: 'v2.0.0',
            sourceDownloadUrl: 'https://github.com/openai/codex/releases/download/v2.0.0/linux.zip',
            lastAttemptedAt: '2026-04-09T12:00:00.000Z',
            lastSyncedAt: '2026-04-09T12:00:00.000Z',
            status: 'synced',
          }),
        ],
      }),
    )

    const index = await store.loadManifestIndex()
    const repository = index.repositories[0]!
    expect(repository).toMatchObject({
      repositoryKey: 'openai/codex',
      releaseTagName: 'v2.0.0',
      status: 'synced',
      lastAttemptedAt: '2026-04-09T12:00:00.000Z',
      lastSuccessfulAt: '2026-04-09T12:00:00.000Z',
    })
    expect(repository.releases).toEqual([
      expect.objectContaining({
        releaseTagName: 'v1.0.0',
        status: 'failed',
        lastAttemptedAt: '2026-04-09T11:00:00.000Z',
        lastSuccessfulAt: '2026-04-09T10:00:00.000Z',
      }),
      expect.objectContaining({
        releaseTagName: 'v2.0.0',
        status: 'synced',
        lastAttemptedAt: '2026-04-09T12:00:00.000Z',
        lastSuccessfulAt: '2026-04-09T12:00:00.000Z',
      }),
    ])
  })

  it('preserves the repository manifest path in the surfaced error when the root index upload fails', async () => {
    const indexBlobName = buildReleaseSyncManifestIndexBlobName('custom-prefix')
    const error = new Error('index upload failed') as Error & { code?: string; statusCode?: number }
    error.code = 'AuthorizationPermissionMismatch'
    error.statusCode = 403
    const containerClient = new FailingRootIndexUploadContainerClient(indexBlobName, error)
    const store = createReleaseSyncMetadataStore({
      prefix: 'custom-prefix',
      now: () => new Date('2026-04-09T10:05:00.000Z'),
      containerClient,
    })

    await expect(
      store.saveManifest(
        createManifest({
          releaseTagName: 'v1.0.0',
          records: [createManifestRecord()],
        }),
      ),
    ).rejects.toThrow(
      /custom-prefix\/openai\/codex\/v1\.0\.0\/manifest\.json.*custom-prefix\/index\.json/u,
    )

    await expect(store.loadManifest('openai/codex', 'v1.0.0')).resolves.toMatchObject({
      blobPath: 'custom-prefix/openai/codex/v1.0.0/manifest.json',
      records: [expect.objectContaining({ releaseTagName: 'v1.0.0' })],
    })
  })

  it('classifies Azure permission mismatches as permission errors', async () => {
    const error = new Error('Permission mismatch') as Error & { code?: string; statusCode?: number }
    error.code = 'AuthorizationPermissionMismatch'
    error.statusCode = 403

    const store = createReleaseSyncMetadataStore({
      now: () => new Date('2026-04-10T08:00:00.000Z'),
      containerSasUrl: validSasUrl,
      containerClient: new ThrowingContainerClient(error),
    })

    await expect(store.loadManifest('openai/codex')).rejects.toThrow(/\[权限不足\]/)
  })

  it('skips container preflight when using a container SAS URL', async () => {
    const error = new Error('This request is not authorized to perform this operation.') as Error & {
      code?: string
      statusCode?: number
    }
    error.code = 'AuthorizationFailure'
    error.statusCode = 403
    const containerClient = new ThrowingContainerClient(error)

    const store = createReleaseSyncMetadataStore({
      now: () => new Date('2026-04-10T08:00:00.000Z'),
      containerSasUrl: validSasUrl,
      containerClient,
    })

    await expect(store.loadManifest('openai/codex')).rejects.toThrow(/\[网络限制\]/)
    expect(containerClient.createIfNotExistsCalls).toBe(0)
  })

  it('classifies expired SAS windows as signature issues', async () => {
    const error = new Error('Server failed to authenticate the request.') as Error & {
      code?: string
      statusCode?: number
    }
    error.code = 'AuthenticationFailed'
    error.statusCode = 403

    const store = createReleaseSyncMetadataStore({
      now: () => new Date('2026-04-10T08:00:00.000Z'),
      containerSasUrl:
        'https://storage.blob.core.windows.net/release-sync?sv=2024-11-04&spr=https&sp=rcwl&st=2026-04-08T00:00:00Z&se=2026-04-09T00:00:00Z&sig=test',
      containerClient: new ThrowingContainerClient(error),
    })

    await expect(store.loadManifest('openai/codex')).rejects.toThrow(/\[SAS 失效\/签名问题\].*已过期/u)
  })

  it('still runs container preflight when using connection string mode', async () => {
    const error = new Error('Permission mismatch') as Error & { code?: string; statusCode?: number }
    error.code = 'AuthorizationPermissionMismatch'
    error.statusCode = 403
    const containerClient = new ThrowingContainerClient(error)

    const store = createReleaseSyncMetadataStore({
      now: () => new Date('2026-04-10T08:00:00.000Z'),
      connectionString: 'UseDevelopmentStorage=true',
      containerName: 'release-sync',
      containerClient,
    })

    await expect(store.loadManifest('openai/codex')).rejects.toThrow(/\[权限不足\]/)
    expect(containerClient.createIfNotExistsCalls).toBe(1)
  })
})

describe('createAzureBlobContainerClient', () => {
  it('builds a container client from a SAS URL', () => {
    const client = createAzureBlobContainerClient({
      containerSasUrl: validSasUrl,
    })

    expect(client.url).toContain('https://storage.blob.core.windows.net/release-sync?')
  })
})
