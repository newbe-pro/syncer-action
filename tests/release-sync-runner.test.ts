import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNetdiskProviderError } from '../src/netdisk-provider'
import { createReleaseSyncRunner } from '../src/release-sync-runner'
import {
  type DownloadedReleaseAsset,
  type GitHubReleaseAsset,
  type ReleaseSyncManifest,
  type ReleaseSyncRecord,
} from '../src/release-sync-contracts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

const targetRepository = {
  key: 'openai/codex',
  owner: 'openai',
  repo: 'codex',
  targetDirectory: '/syncer/codex',
}

const powerToysRepository = {
  key: 'microsoft/PowerToys',
  owner: 'microsoft',
  repo: 'PowerToys',
  targetDirectory: '/syncer/powertoys',
  assetExcludePatterns: ['*symbols*'],
}

const baseAsset: GitHubReleaseAsset = {
  repositoryKey: targetRepository.key,
  releaseId: 101,
  releaseTagName: 'v1.0.0',
  releaseName: 'v1.0.0',
  releasePublishedAt: '2026-04-09T09:00:00.000Z',
  latestReleaseId: 101,
  latestReleaseTagName: 'v1.0.0',
  latestReleasePublishedAt: '2026-04-09T09:00:00.000Z',
  assetId: 202,
  assetName: 'codex-linux-x64.zip',
  assetSize: 11,
  browserDownloadUrl: 'https://github.com/openai/codex/releases/download/v1.0.0/codex-linux-x64.zip',
  assetUpdatedAt: '2026-04-09T09:30:00.000Z',
}

const outdatedAsset: GitHubReleaseAsset = {
  ...baseAsset,
  releaseId: 99,
  releaseTagName: 'v0.9.0',
  releaseName: 'v0.9.0',
  releasePublishedAt: '2026-04-08T09:00:00.000Z',
  assetId: 201,
  browserDownloadUrl: 'https://github.com/openai/codex/releases/download/v0.9.0/codex-linux-x64.zip',
}

const shellAsset: GitHubReleaseAsset = {
  ...baseAsset,
  assetId: 203,
  assetName: 'install.sh',
  assetSize: 10,
  browserDownloadUrl: 'https://github.com/openai/codex/releases/download/v1.0.0/install.sh',
}

const powershellAsset: GitHubReleaseAsset = {
  ...baseAsset,
  assetId: 204,
  assetName: 'install.ps1',
  assetSize: 12,
  browserDownloadUrl: 'https://github.com/openai/codex/releases/download/v1.0.0/install.ps1',
}

const powerToysInstallerAsset: GitHubReleaseAsset = {
  ...baseAsset,
  repositoryKey: powerToysRepository.key,
  assetId: 205,
  assetName: 'PowerToysUserSetup-0.90.0-x64.exe',
  browserDownloadUrl:
    'https://github.com/microsoft/PowerToys/releases/download/v1.0.0/PowerToysUserSetup-0.90.0-x64.exe',
}

const powerToysSymbolsAsset: GitHubReleaseAsset = {
  ...powerToysInstallerAsset,
  assetId: 206,
  assetName: 'PowerToysSetup-0.90.0-x64-symbols.zip',
  browserDownloadUrl:
    'https://github.com/microsoft/PowerToys/releases/download/v1.0.0/PowerToysSetup-0.90.0-x64-symbols.zip',
}

async function createDownloadedAsset(
  asset: GitHubReleaseAsset,
  contents = 'hello world',
): Promise<DownloadedReleaseAsset> {
  const directory = await mkdtemp(path.join(tmpdir(), 'syncer-release-service-'))
  temporaryDirectories.push(directory)
  const filePath = path.join(directory, asset.assetName)
  await writeFile(filePath, contents)

  return {
    asset,
    filePath,
    byteSize: Buffer.byteLength(contents),
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function createManifest(records: ReleaseSyncRecord[] = []): ReleaseSyncManifest {
  return {
    repositoryKey: targetRepository.key,
    releaseTagName: baseAsset.latestReleaseTagName,
    version: 1,
    updatedAt: '2026-04-09T09:00:00.000Z',
    records,
  }
}

function createManifestForRepository(
  repositoryKey: string,
  releaseTagName: string,
  records: ReleaseSyncRecord[] = [],
): ReleaseSyncManifest {
  return {
    repositoryKey,
    releaseTagName,
    version: 1,
    updatedAt: '2026-04-09T09:00:00.000Z',
    records,
  }
}

describe('createReleaseSyncRunner', () => {
  it('syncs latest-release assets and persists versioned receipts', async () => {
    let persistedManifest = createManifest()
    const metadataStore = {
      loadManifest: vi.fn(async () => persistedManifest),
      loadManifestIndex: vi.fn(),
      saveManifest: vi.fn(async (manifest: ReleaseSyncManifest) => {
        persistedManifest = { ...manifest, etag: 'etag-1' }
        return persistedManifest
      }),
    }

    const provider = {
      providerName: '123pan',
      uploadAsset: vi.fn(async () => ({
        providerName: '123pan',
        remoteFileId: '123pan-asset-1',
        shareUrl: 'https://123pan.example/download/123pan-asset-1',
        uploadedAt: '2026-04-09T10:00:00.000Z',
      })),
    }

    const source = {
      targets: [targetRepository],
      listReleaseAssets: vi.fn(async () => [baseAsset]),
      downloadAsset: vi.fn(async () => createDownloadedAsset(baseAsset)),
    }

    const service = createReleaseSyncRunner({
      source,
      provider,
      metadataStore,
      now: () => new Date('2026-04-09T10:00:00.000Z'),
    })

    const summary = await service.run()

    expect(summary.providerName).toBe('123pan')
    expect(summary.discoveredAssetCount).toBe(1)
    expect(summary.processedAssetCount).toBe(1)
    expect(summary.syncedCount).toBe(1)
    expect(summary.skippedCount).toBe(0)
    expect(summary.failedCount).toBe(0)
    expect(metadataStore.loadManifest).toHaveBeenCalledWith(
      targetRepository.key,
      baseAsset.latestReleaseTagName,
    )
    expect(source.downloadAsset).toHaveBeenCalledTimes(1)
    expect(source.downloadAsset).toHaveBeenCalledWith(baseAsset, { signal: undefined })
    expect(provider.uploadAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: {
          repositoryKey: targetRepository.key,
          targetDirectory: '/syncer/codex/v1.0.0',
        },
      }),
    )
    expect(metadataStore.saveManifest).toHaveBeenCalledTimes(1)
    expect(persistedManifest.releaseTagName).toBe('v1.0.0')
    expect(persistedManifest.records[0]).toMatchObject({
      status: 'synced',
      providerName: '123pan',
      remoteFileId: '123pan-asset-1',
      shareUrl: 'https://123pan.example/download/123pan-asset-1',
      failureStage: null,
    })
    expect(summary.repositories[0]?.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetName: baseAsset.assetName,
          status: 'synced',
        }),
      ]),
    )
  })

  it('skips unchanged assets without downloading them again', async () => {
    const metadataStore = {
      loadManifest: vi.fn(async () =>
        createManifest([
          {
            repositoryKey: baseAsset.repositoryKey,
            releaseId: baseAsset.releaseId,
            releaseTagName: baseAsset.releaseTagName,
            assetId: baseAsset.assetId,
            assetName: baseAsset.assetName,
            assetSize: baseAsset.assetSize,
            assetUpdatedAt: baseAsset.assetUpdatedAt,
            sourceDownloadUrl: baseAsset.browserDownloadUrl,
            sha256: 'existing-sha',
            providerName: 'mock',
            remoteFileId: 'mock-asset-1',
            shareUrl: 'https://mock.example.com/share/mock-asset-1',
            status: 'synced',
            firstSyncedAt: '2026-04-09T10:00:00.000Z',
            lastSyncedAt: '2026-04-09T10:00:00.000Z',
            lastAttemptedAt: '2026-04-09T10:00:00.000Z',
            failureStage: null,
            failureMessage: null,
            failureDiagnostics: null,
          },
        ]),
      ),
      loadManifestIndex: vi.fn(),
      saveManifest: vi.fn(),
    }

    const source = {
      targets: [targetRepository],
      listReleaseAssets: vi.fn(async () => [baseAsset]),
      downloadAsset: vi.fn(),
    }

    const service = createReleaseSyncRunner({
      source,
      provider: {
        providerName: 'mock',
        uploadAsset: vi.fn(),
      },
      metadataStore,
      now: () => new Date('2026-04-09T10:00:00.000Z'),
    })

    const summary = await service.run()

    expect(summary.skippedCount).toBe(1)
    expect(summary.failedCount).toBe(0)
    expect(metadataStore.loadManifest).toHaveBeenCalledWith(
      targetRepository.key,
      baseAsset.latestReleaseTagName,
    )
    expect(source.downloadAsset).not.toHaveBeenCalled()
    expect(metadataStore.saveManifest).not.toHaveBeenCalled()
  })

  it('ignores non-latest assets without polluting current-run counts or outcomes', async () => {
    let persistedManifest = createManifest()
    const metadataStore = {
      loadManifest: vi.fn(async () => persistedManifest),
      loadManifestIndex: vi.fn(),
      saveManifest: vi.fn(async (manifest: ReleaseSyncManifest) => {
        persistedManifest = manifest
        return manifest
      }),
    }
    const source = {
      targets: [targetRepository],
      listReleaseAssets: vi.fn(async () => [outdatedAsset, baseAsset]),
      downloadAsset: vi.fn(async () => createDownloadedAsset(baseAsset)),
    }
    const provider = {
      providerName: '123pan',
      uploadAsset: vi.fn(async () => ({
        providerName: '123pan',
        remoteFileId: '123pan-asset-1',
        shareUrl: 'https://123pan.example/download/123pan-asset-1',
        uploadedAt: '2026-04-09T10:00:00.000Z',
      })),
    }

    const service = createReleaseSyncRunner({
      source,
      provider,
      metadataStore,
      now: () => new Date('2026-04-09T10:00:00.000Z'),
    })

    const summary = await service.run()

    expect(summary.discoveredAssetCount).toBe(1)
    expect(summary.processedAssetCount).toBe(1)
    expect(summary.syncedCount).toBe(1)
    expect(summary.skippedCount).toBe(0)
    expect(summary.failedCount).toBe(0)
    expect(summary.repositories[0]?.outcomes).toEqual([
      expect.objectContaining({
        assetName: baseAsset.assetName,
        status: 'synced',
      }),
    ])
    expect(metadataStore.loadManifest).toHaveBeenCalledWith(
      targetRepository.key,
      baseAsset.latestReleaseTagName,
    )
    expect(source.downloadAsset).toHaveBeenCalledTimes(1)
    expect(source.downloadAsset).toHaveBeenCalledWith(baseAsset, { signal: undefined })
    expect(provider.uploadAsset).toHaveBeenCalledTimes(1)
    expect(metadataStore.saveManifest).toHaveBeenCalledTimes(1)
  })

  it('treats a non-latest-only discovery result as no current-run work when every asset is stale', async () => {
    const metadataStore = {
      loadManifest: vi.fn(async () => createManifest()),
      loadManifestIndex: vi.fn(),
      saveManifest: vi.fn(),
    }
    const source = {
      targets: [targetRepository],
      listReleaseAssets: vi.fn(async () => [outdatedAsset]),
      downloadAsset: vi.fn(),
    }
    const provider = {
      providerName: '123pan',
      uploadAsset: vi.fn(),
    }

    const service = createReleaseSyncRunner({
      source,
      provider,
      metadataStore,
      now: () => new Date('2026-04-09T10:00:00.000Z'),
    })

    const summary = await service.run()

    expect(summary.discoveredAssetCount).toBe(0)
    expect(summary.processedAssetCount).toBe(0)
    expect(summary.syncedCount).toBe(0)
    expect(summary.skippedCount).toBe(0)
    expect(summary.failedCount).toBe(0)
    expect(summary.repositories[0]?.outcomes).toEqual([])
    expect(metadataStore.loadManifest).not.toHaveBeenCalled()
    expect(source.downloadAsset).not.toHaveBeenCalled()
    expect(provider.uploadAsset).not.toHaveBeenCalled()
    expect(metadataStore.saveManifest).not.toHaveBeenCalled()
  })

  it('skips PowerToys symbols packages before download, upload, or manifest writes', async () => {
    const metadataStore = {
      loadManifest: vi.fn(async () =>
        createManifestForRepository(
          powerToysRepository.key,
          powerToysSymbolsAsset.latestReleaseTagName,
        ),
      ),
      loadManifestIndex: vi.fn(),
      saveManifest: vi.fn(),
    }
    const source = {
      targets: [powerToysRepository],
      listReleaseAssets: vi.fn(async () => [powerToysSymbolsAsset]),
      downloadAsset: vi.fn(),
    }
    const provider = {
      providerName: '123pan',
      uploadAsset: vi.fn(),
    }

    const service = createReleaseSyncRunner({
      source,
      provider,
      metadataStore,
      now: () => new Date('2026-04-09T10:00:00.000Z'),
    })

    const summary = await service.run()

    expect(summary.syncedCount).toBe(0)
    expect(summary.skippedCount).toBe(1)
    expect(summary.failedCount).toBe(0)
    expect(summary.repositories[0]?.outcomes[0]).toMatchObject({
      status: 'skipped',
      assetName: powerToysSymbolsAsset.assetName,
      message: expect.stringContaining('repository exclusion rule "*symbols*"'),
    })
    expect(metadataStore.loadManifest).not.toHaveBeenCalled()
    expect(source.downloadAsset).not.toHaveBeenCalled()
    expect(provider.uploadAsset).not.toHaveBeenCalled()
    expect(metadataStore.saveManifest).not.toHaveBeenCalled()
  })

  it('continues syncing normal PowerToys installers that do not match exclusion rules', async () => {
    let persistedManifest = createManifestForRepository(
      powerToysRepository.key,
      powerToysInstallerAsset.latestReleaseTagName,
    )
    const metadataStore = {
      loadManifest: vi.fn(async () => persistedManifest),
      loadManifestIndex: vi.fn(),
      saveManifest: vi.fn(async (manifest: ReleaseSyncManifest) => {
        persistedManifest = manifest
        return manifest
      }),
    }
    const provider = {
      providerName: '123pan',
      uploadAsset: vi.fn(async () => ({
        providerName: '123pan',
        remoteFileId: '123pan-asset-pt-1',
        shareUrl: 'https://123pan.example/download/123pan-asset-pt-1',
        uploadedAt: '2026-04-09T10:00:00.000Z',
      })),
    }
    const source = {
      targets: [powerToysRepository],
      listReleaseAssets: vi.fn(async () => [
        powerToysSymbolsAsset,
        powerToysInstallerAsset,
      ]),
      downloadAsset: vi.fn(async (asset: GitHubReleaseAsset) => createDownloadedAsset(asset)),
    }

    const service = createReleaseSyncRunner({
      source,
      provider,
      metadataStore,
      now: () => new Date('2026-04-09T10:00:00.000Z'),
    })

    const summary = await service.run()

    expect(summary.syncedCount).toBe(1)
    expect(summary.skippedCount).toBe(1)
    expect(summary.failedCount).toBe(0)
    expect(source.downloadAsset).toHaveBeenCalledTimes(1)
    expect(source.downloadAsset).toHaveBeenCalledWith(powerToysInstallerAsset, {
      signal: undefined,
    })
    expect(provider.uploadAsset).toHaveBeenCalledTimes(1)
    expect(provider.uploadAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        asset: powerToysInstallerAsset,
        destination: expect.objectContaining({
          targetDirectory: '/syncer/powertoys/v1.0.0',
        }),
      }),
    )
    expect(metadataStore.saveManifest).toHaveBeenCalledTimes(1)
    expect(persistedManifest.records).toHaveLength(1)
    expect(persistedManifest.records[0]?.assetName).toBe(
      powerToysInstallerAsset.assetName,
    )
    expect(summary.repositories[0]?.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetName: powerToysSymbolsAsset.assetName,
          status: 'skipped',
          message: expect.stringContaining('repository exclusion rule "*symbols*"'),
        }),
        expect.objectContaining({
          assetName: powerToysInstallerAsset.assetName,
          status: 'synced',
        }),
      ]),
    )
  })

  it('skips script assets while continuing to sync archive packages', async () => {
    let persistedManifest = createManifest()
    const metadataStore = {
      loadManifest: vi.fn(async () => persistedManifest),
      loadManifestIndex: vi.fn(),
      saveManifest: vi.fn(async (manifest: ReleaseSyncManifest) => {
        persistedManifest = manifest
        return manifest
      }),
    }
    const provider = {
      providerName: '123pan',
      uploadAsset: vi.fn(async () => ({
        providerName: '123pan',
        remoteFileId: '123pan-asset-1',
        shareUrl: 'https://123pan.example/download/123pan-asset-1',
        uploadedAt: '2026-04-09T10:00:00.000Z',
      })),
    }
    const source = {
      targets: [targetRepository],
      listReleaseAssets: vi.fn(async () => [baseAsset, shellAsset, powershellAsset]),
      downloadAsset: vi.fn(async (asset: GitHubReleaseAsset) => createDownloadedAsset(asset)),
    }

    const service = createReleaseSyncRunner({
      source,
      provider,
      metadataStore,
      now: () => new Date('2026-04-09T10:00:00.000Z'),
    })

    const summary = await service.run()

    expect(summary.discoveredAssetCount).toBe(3)
    expect(summary.processedAssetCount).toBe(3)
    expect(summary.syncedCount).toBe(1)
    expect(summary.skippedCount).toBe(2)
    expect(summary.failedCount).toBe(0)
    expect(source.downloadAsset).toHaveBeenCalledTimes(1)
    expect(source.downloadAsset).toHaveBeenCalledWith(baseAsset, { signal: undefined })
    expect(provider.uploadAsset).toHaveBeenCalledTimes(1)
    expect(provider.uploadAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        asset: baseAsset,
        destination: expect.objectContaining({
          targetDirectory: '/syncer/codex/v1.0.0',
        }),
      }),
    )
    expect(metadataStore.saveManifest).toHaveBeenCalledTimes(1)
    expect(persistedManifest.records).toHaveLength(1)
    expect(persistedManifest.records[0]?.assetName).toBe(baseAsset.assetName)
    expect(summary.repositories[0]?.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetName: baseAsset.assetName,
          status: 'synced',
        }),
        expect.objectContaining({
          assetName: shellAsset.assetName,
          status: 'skipped',
          message: expect.stringContaining('script assets are not uploaded'),
        }),
        expect.objectContaining({
          assetName: powershellAsset.assetName,
          status: 'skipped',
          message: expect.stringContaining('script assets are not uploaded'),
        }),
      ]),
    )
  })

  it('persists download failures without invoking the provider', async () => {
    let persistedManifest = createManifest()
    const provider = {
      providerName: 'mock',
      uploadAsset: vi.fn(),
    }
    const metadataStore = {
      loadManifest: vi.fn(async () => persistedManifest),
      loadManifestIndex: vi.fn(),
      saveManifest: vi.fn(async (manifest: ReleaseSyncManifest) => {
        persistedManifest = manifest
        return manifest
      }),
    }
    const source = {
      targets: [targetRepository],
      listReleaseAssets: vi.fn(async () => [baseAsset]),
      downloadAsset: vi.fn(async () => {
        throw new Error('download exploded')
      }),
    }

    const service = createReleaseSyncRunner({
      source,
      provider,
      metadataStore,
      now: () => new Date('2026-04-09T10:00:00.000Z'),
    })

    const summary = await service.run()

    expect(summary.failedCount).toBe(1)
    expect(summary.repositories[0]?.outcomes[0]?.status).toBe('download_failed')
    expect(provider.uploadAsset).not.toHaveBeenCalled()
    expect(persistedManifest.records[0]).toMatchObject({
      status: 'download_failed',
      failureStage: null,
      failureMessage: 'download exploded',
    })
  })

  it('persists upload failures with normalized provider stages', async () => {
    let persistedManifest = createManifest()
    const metadataStore = {
      loadManifest: vi.fn(async () => persistedManifest),
      loadManifestIndex: vi.fn(),
      saveManifest: vi.fn(async (manifest: ReleaseSyncManifest) => {
        persistedManifest = manifest
        return manifest
      }),
    }
    const provider = {
      providerName: '123pan',
      uploadAsset: vi.fn(async () => {
        throw createNetdiskProviderError({
          providerName: '123pan',
          stage: 'upload',
          asset: baseAsset,
          error: new Error('directory exploded'),
          diagnostics: {
            detailLevel: 'summary',
            response: {
              status: 429,
              statusText: 'Too Many Requests',
            },
            provider: {
              code: 42901,
              message: 'upload rate limit',
            },
          },
        })
      }),
    }
    const source = {
      targets: [targetRepository],
      listReleaseAssets: vi.fn(async () => [baseAsset]),
      downloadAsset: vi.fn(async () => createDownloadedAsset(baseAsset)),
    }

    const service = createReleaseSyncRunner({
      source,
      provider,
      metadataStore,
      now: () => new Date('2026-04-09T10:00:00.000Z'),
    })

    const summary = await service.run()

    expect(summary.failedCount).toBe(1)
    expect(summary.failures[0]).toMatchObject({
      providerName: '123pan',
      failureStage: 'upload',
      diagnostics: {
        detailLevel: 'summary',
        response: {
          status: 429,
        },
        provider: {
          code: 42901,
        },
      },
    })
    expect(summary.repositories[0]?.outcomes[0]).toMatchObject({
      status: 'upload_failed',
      failureStage: 'upload',
      failureDiagnostics: {
        detailLevel: 'summary',
      },
    })
    expect(persistedManifest.records[0]).toMatchObject({
      status: 'upload_failed',
      failureStage: 'upload',
      providerName: '123pan',
      failureDiagnostics: {
        detailLevel: 'summary',
        provider: {
          code: 42901,
        },
      },
    })
  })

  it('reports metadata persistence failures separately from transfer success', async () => {
    const metadataStore = {
      loadManifest: vi.fn(async () => createManifest()),
      loadManifestIndex: vi.fn(),
      saveManifest: vi.fn(async () => {
        throw new Error('azure write exploded')
      }),
    }
    const source = {
      targets: [targetRepository],
      listReleaseAssets: vi.fn(async () => [baseAsset]),
      downloadAsset: vi.fn(async () => createDownloadedAsset(baseAsset)),
    }
    const provider = {
      providerName: 'mock',
      uploadAsset: vi.fn(async () => ({
        providerName: 'mock',
        remoteFileId: 'mock-asset-1',
        shareUrl: 'https://mock.example.com/share/mock-asset-1',
        uploadedAt: '2026-04-09T10:00:00.000Z',
      })),
    }

    const service = createReleaseSyncRunner({
      source,
      provider,
      metadataStore,
      now: () => new Date('2026-04-09T10:00:00.000Z'),
    })

    const summary = await service.run()

    expect(summary.syncedCount).toBe(1)
    expect(summary.failedCount).toBe(0)
    expect(summary.repositories[0]?.outcomes[0]?.status).toBe('synced')
    expect(summary.failures).toEqual([])
    expect(summary.metadataPublicationFailure?.message).toContain('azure write exploded')
  })
})
