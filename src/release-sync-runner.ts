import { describeLocalFile } from './file-digest'
import { type GitHubReleaseSource } from './github-release-source'
import {
  assertValidNetdiskUploadReceipt,
  normalizeNetdiskUploadError,
  type NetdiskProvider,
} from './netdisk-provider'
import {
  type GitHubReleaseAsset,
  type MetadataPublicationFailure,
  type NetdiskFailureDiagnostics,
  type NetdiskFailureStage,
  type ReleaseSyncAssetOutcome,
  type ReleaseSyncAssetOutcomeStatus,
  type ReleaseSyncManifest,
  type ReleaseSyncRecord,
  type ReleaseSyncRepositorySummary,
  type ReleaseSyncRunFailure,
  type ReleaseSyncRunSummary,
} from './release-sync-contracts'
import {
  MetadataPublicationError,
  type ReleaseSyncMetadataStore,
} from './metadata/azure-manifest-store'

interface Logger {
  info?(message: string): void
  warn?(message: string): void
  error?(message: string): void
}

export interface ReleaseSyncRunner {
  run(options?: {
    signal?: AbortSignal
    onAssetStart?(asset: GitHubReleaseAsset): Promise<void> | void
  }): Promise<ReleaseSyncRunSummary>
}

interface ProcessedAssetResult {
  asset: GitHubReleaseAsset
  outcome: ReleaseSyncAssetOutcome
  record?: ReleaseSyncRecord
}

function isScriptAsset(assetName: string) {
  const normalizedAssetName = assetName.toLowerCase()
  return normalizedAssetName.endsWith('.sh') || normalizedAssetName.endsWith('.ps1')
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return 'unknown size'
  }

  if (bytes < 1024) {
    return `${bytes} B`
  }

  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`
}

function formatDiagnosticsForLog(
  diagnostics: NetdiskFailureDiagnostics | null | undefined,
): string {
  if (!diagnostics) {
    return ''
  }

  const segments: string[] = []

  const request = diagnostics.request
  if (request?.method || request?.host || request?.path) {
    const location = [request?.host, request?.path].filter(Boolean).join('')
    segments.push(`${request?.method ?? 'REQUEST'} ${location}`.trim())
  }

  const response = diagnostics.response
  if (response?.status || response?.statusText || response?.bodyExcerpt) {
    const status = [response?.status, response?.statusText].filter(Boolean).join(' ')
    segments.push(status ? `response ${status}` : 'response')
    if (response?.bodyExcerpt) {
      segments.push(`body=${response.bodyExcerpt}`)
    }
  }

  const provider = diagnostics.provider
  if (provider?.code || provider?.message) {
    segments.push(`provider ${provider?.code ?? ''}${provider?.message ? `: ${provider.message}` : ''}`.trim())
  }

  const transport = diagnostics.transport
  if (transport?.type || transport?.message) {
    segments.push(
      `transport ${transport?.type ?? 'unknown'}${transport?.message ? `: ${transport.message}` : ''}`.trim(),
    )
  }

  const retry = diagnostics.retry
  if (retry?.attempts != null || retry?.maxAttempts != null) {
    segments.push(
      `retry ${retry?.attempts ?? 0}/${retry?.maxAttempts ?? '?'}${retry?.intervalMs != null ? ` (~${retry.intervalMs}ms)` : ''}`,
    )
  }

  if (segments.length === 0) {
    return ''
  }

  return ` [${segments.join('; ')}]`
}

function isLatestReleaseAsset(asset: GitHubReleaseAsset) {
  return (
    asset.releaseId === asset.latestReleaseId &&
    asset.releaseTagName === asset.latestReleaseTagName
  )
}

function escapeForRegularExpression(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

function createCaseInsensitiveGlobRegExp(pattern: string) {
  let regularExpression = '^'

  for (const character of pattern) {
    if (character === '*') {
      regularExpression += '.*'
      continue
    }

    if (character === '?') {
      regularExpression += '.'
      continue
    }

    regularExpression += escapeForRegularExpression(character)
  }

  regularExpression += '$'
  return new RegExp(regularExpression, 'i')
}

function findMatchingAssetExcludePattern(
  assetName: string,
  assetExcludePatterns: string[] | undefined,
) {
  return assetExcludePatterns?.find((pattern) =>
    createCaseInsensitiveGlobRegExp(pattern).test(assetName),
  )
}

function buildVersionedTargetDirectory(
  targetDirectory: string | undefined,
  releaseTagName: string,
) {
  if (!targetDirectory?.trim()) {
    return undefined
  }

  return `${targetDirectory.replace(/\/+$/, '')}/${releaseTagName}`
}

function findManifestRecord(manifest: ReleaseSyncManifest, asset: GitHubReleaseAsset) {
  return manifest.records.find(
    (record) =>
      record.repositoryKey === asset.repositoryKey &&
      record.releaseId === asset.releaseId &&
      record.assetId === asset.assetId,
  )
}

function upsertManifestRecord(manifest: ReleaseSyncManifest, nextRecord: ReleaseSyncRecord) {
  const nextRecords = manifest.records.filter(
    (record) =>
      !(
        record.repositoryKey === nextRecord.repositoryKey &&
        record.releaseId === nextRecord.releaseId &&
        record.assetId === nextRecord.assetId
      ),
  )
  nextRecords.push(nextRecord)

  return {
    ...manifest,
    records: nextRecords,
  }
}

function shouldSkipWithoutDownload(
  existingRecord: ReleaseSyncRecord | undefined,
  asset: GitHubReleaseAsset,
) {
  return (
    existingRecord?.status === 'synced' &&
    existingRecord.assetUpdatedAt === asset.assetUpdatedAt &&
    existingRecord.assetSize === asset.assetSize &&
    Boolean(existingRecord.sha256)
  )
}

function createRecordFromAttempt(input: {
  asset: GitHubReleaseAsset
  existingRecord?: ReleaseSyncRecord
  sha256: string | null
  providerName: string | null
  remoteFileId: string | null
  shareUrl: string | null
  status: ReleaseSyncRecord['status']
  attemptedAt: string
  failureStage: NetdiskFailureStage | null
  failureMessage: string | null
  failureDiagnostics?: NetdiskFailureDiagnostics | null
}) {
  const { asset, existingRecord } = input
  const syncedAt =
    input.status === 'synced'
      ? input.attemptedAt
      : existingRecord?.lastSyncedAt ?? null

  return {
    repositoryKey: asset.repositoryKey,
    releaseId: asset.releaseId,
    releaseTagName: asset.releaseTagName,
    assetId: asset.assetId,
    assetName: asset.assetName,
    assetSize: asset.assetSize,
    assetUpdatedAt: asset.assetUpdatedAt,
    sourceDownloadUrl: asset.browserDownloadUrl,
    sha256: input.sha256,
    providerName: input.providerName,
    remoteFileId: input.remoteFileId,
    shareUrl: input.shareUrl,
    status: input.status,
    firstSyncedAt:
      input.status === 'synced'
        ? existingRecord?.firstSyncedAt ?? input.attemptedAt
        : existingRecord?.firstSyncedAt ?? null,
    lastSyncedAt: syncedAt,
    lastAttemptedAt: input.attemptedAt,
    failureStage: input.failureStage,
    failureMessage: input.failureMessage,
    failureDiagnostics: input.failureDiagnostics ?? null,
  } satisfies ReleaseSyncRecord
}

function createAssetOutcome(input: {
  asset: GitHubReleaseAsset
  status: ReleaseSyncAssetOutcomeStatus
  message: string
  sha256: string | null
  providerName: string | null
  shareUrl: string | null
  failureStage: NetdiskFailureStage | null
  failureOccurredAt?: string | null
  failureDiagnostics?: NetdiskFailureDiagnostics | null
}) {
  return {
    repositoryKey: input.asset.repositoryKey,
    releaseId: input.asset.releaseId,
    assetId: input.asset.assetId,
    assetName: input.asset.assetName,
    status: input.status,
    message: input.message,
    sha256: input.sha256,
    providerName: input.providerName,
    shareUrl: input.shareUrl,
    failureStage: input.failureStage,
    failureOccurredAt: input.failureOccurredAt ?? null,
    failureDiagnostics: input.failureDiagnostics ?? null,
  } satisfies ReleaseSyncAssetOutcome
}

function addOutcome(
  repositorySummary: ReleaseSyncRepositorySummary,
  failures: ReleaseSyncRunFailure[],
  outcome: ReleaseSyncAssetOutcome,
) {
  repositorySummary.outcomes.push(outcome)
  repositorySummary.processedAssetCount += 1

  if (outcome.status === 'synced') {
    repositorySummary.syncedCount += 1
    return
  }

  if (outcome.status === 'skipped') {
    repositorySummary.skippedCount += 1
    return
  }

  repositorySummary.failedCount += 1
  failures.push({
    repositoryKey: outcome.repositoryKey,
    releaseId: outcome.releaseId,
    assetId: outcome.assetId,
    assetName: outcome.assetName,
    providerName: outcome.providerName,
    failureStage: outcome.failureStage,
    message: outcome.message,
    occurredAt: outcome.failureOccurredAt ?? null,
    diagnostics: outcome.failureDiagnostics ?? null,
  })
}

async function mapWithConcurrencyLimit<T>(
  values: readonly T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<void>,
) {
  const normalizedLimit = Math.max(1, Math.trunc(limit) || 1)
  let currentIndex = 0

  await Promise.all(
    Array.from({ length: Math.min(normalizedLimit, values.length) }, async () => {
      while (true) {
        const index = currentIndex
        currentIndex += 1
        if (index >= values.length) {
          return
        }

        await mapper(values[index]!, index)
      }
    }),
  )
}

function normalizeMetadataFailure(
  error: unknown,
  manifest: ReleaseSyncManifest,
): MetadataPublicationFailure {
  if (error instanceof MetadataPublicationError) {
    return error.details
  }

  const message = error instanceof Error ? error.message : 'Unknown metadata publication error.'

  return {
    repositoryKey: manifest.repositoryKey,
    message,
    manifestPath:
      manifest.blobPath ?? `${manifest.repositoryKey}/${manifest.releaseTagName ?? '<release-tag>'}`,
    rootIndexPath: 'index.json',
    manifestPersisted: false,
    occurredAt: new Date().toISOString(),
  }
}

export function formatReleaseSyncRunSummary(summary: ReleaseSyncRunSummary) {
  if (summary.repositoryCount === 0) {
    return 'GitHub release sync completed: no repositories configured.'
  }

  const providerSegment = summary.providerName
    ? ` through ${summary.providerName}`
    : ''
  const metadataSegment = summary.metadataPublicationFailure
    ? ', metadata publication failed'
    : ''

  return [
    `GitHub release sync completed${providerSegment} for ${summary.repositoryCount} repos`,
    `${summary.discoveredAssetCount} discovered assets`,
    `${summary.syncedCount} synced`,
    `${summary.skippedCount} skipped`,
    `${summary.failedCount} failed${metadataSegment}`,
  ].join(', ')
}

export function createReleaseSyncRunner(options: {
  source: GitHubReleaseSource
  provider: NetdiskProvider
  metadataStore: ReleaseSyncMetadataStore
  now?: () => Date
  logger?: Logger
  describeLocalFile?: typeof describeLocalFile
  maxParallelAssets?: number
  dryRun?: boolean
}): ReleaseSyncRunner {
  const now = options.now ?? (() => new Date())
  const logger = options.logger ?? {}
  const describeFile = options.describeLocalFile ?? describeLocalFile
  const maxParallelAssets = Math.max(1, Math.trunc(options.maxParallelAssets ?? 1) || 1)

  return {
    async run({ signal, onAssetStart } = {}) {
      const startedAt = now().toISOString()
      logger.info?.(
        `[release-sync] Run started at ${startedAt} for ${options.source.targets.length} repository target(s)` +
          (options.dryRun ? ' (dry-run)' : '') +
          `.`,
      )
      logger.info?.(
        `[release-sync] Provider: ${options.provider.providerName}, max parallel assets: ${maxParallelAssets}.`,
      )
      logger.info?.(`[release-sync] Discovering release assets...`)
      const discoveredAssets = await options.source.listReleaseAssets({ signal })
      logger.info?.(
        `[release-sync] Discovered ${discoveredAssets.length} asset(s) across ${options.source.targets.length} repository target(s).`,
      )
      const discoveredAssetsByRepository = new Map<string, GitHubReleaseAsset[]>()

      for (const asset of discoveredAssets) {
        const repositoryAssets = discoveredAssetsByRepository.get(asset.repositoryKey) ?? []
        repositoryAssets.push(asset)
        discoveredAssetsByRepository.set(asset.repositoryKey, repositoryAssets)
      }

      const repositories: ReleaseSyncRepositorySummary[] = []
      const failures: ReleaseSyncRunFailure[] = []
      let metadataPublicationFailure: MetadataPublicationFailure | null = null

      for (const repository of options.source.targets) {
        const repositoryAssets = (discoveredAssetsByRepository.get(repository.key) ?? []).filter(
          isLatestReleaseAsset,
        )
        const repositorySummary: ReleaseSyncRepositorySummary = {
          repositoryKey: repository.key,
          discoveredAssetCount: repositoryAssets.length,
          processedAssetCount: 0,
          syncedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          outcomes: [],
        }
        const resultByAssetId = new Map<number, ProcessedAssetResult>()
        let manifest: ReleaseSyncManifest | undefined

        async function ensureManifest(asset: GitHubReleaseAsset) {
          if (!manifest) {
            manifest = await options.metadataStore.loadManifest(
              repository.key,
              asset.latestReleaseTagName,
            )
          }

          return manifest
        }

        const eligibleAssets: Array<{
          asset: GitHubReleaseAsset
          existingRecord?: ReleaseSyncRecord
        }> = []

        for (const asset of repositoryAssets) {
          await onAssetStart?.(asset)

          if (isScriptAsset(asset.assetName)) {
            logger.info?.(
              `[release-sync] Skipping ${asset.assetName}: script assets are not uploaded.`,
            )
            addOutcome(
              repositorySummary,
              failures,
              createAssetOutcome({
                asset,
                status: 'skipped',
                message: `Skipped ${asset.assetName} because script assets are not uploaded.`,
                sha256: null,
                providerName: null,
                shareUrl: null,
                failureStage: null,
              }),
            )
            continue
          }

          const matchingAssetExcludePattern = findMatchingAssetExcludePattern(
            asset.assetName,
            repository.assetExcludePatterns,
          )
          if (matchingAssetExcludePattern) {
            logger.info?.(
              `[release-sync] Skipping ${asset.assetName}: matches repository exclusion rule "${matchingAssetExcludePattern}".`,
            )
            addOutcome(
              repositorySummary,
              failures,
              createAssetOutcome({
                asset,
                status: 'skipped',
                message: `Skipped ${asset.assetName} because it matches repository exclusion rule "${matchingAssetExcludePattern}" for ${repository.key}.`,
                sha256: null,
                providerName: null,
                shareUrl: null,
                failureStage: null,
              }),
            )
            continue
          }

          const currentManifest = await ensureManifest(asset)
          const existingRecord = findManifestRecord(currentManifest, asset)

          if (shouldSkipWithoutDownload(existingRecord, asset)) {
            logger.info?.(
              `[release-sync] Skipping ${asset.assetName}: metadata shows unchanged content (sha256 present).`,
            )
            addOutcome(
              repositorySummary,
              failures,
              createAssetOutcome({
                asset,
                status: 'skipped',
                message: `Skipped ${asset.assetName} because metadata shows unchanged content.`,
                sha256: existingRecord?.sha256 ?? null,
                providerName: existingRecord?.providerName ?? null,
                shareUrl: existingRecord?.shareUrl ?? null,
                failureStage: null,
              }),
            )
            continue
          }

          eligibleAssets.push({ asset, existingRecord })
        }

        if (options.dryRun) {
          for (const { asset, existingRecord } of eligibleAssets) {
            addOutcome(
              repositorySummary,
              failures,
              createAssetOutcome({
                asset,
                status: 'skipped',
                message: `Dry run: would sync ${asset.assetName} to ${buildVersionedTargetDirectory(repository.targetDirectory, asset.releaseTagName) ?? '/'} through ${options.provider.providerName}.`,
                sha256: existingRecord?.sha256 ?? null,
                providerName: existingRecord?.providerName ?? null,
                shareUrl: existingRecord?.shareUrl ?? null,
                failureStage: null,
              }),
            )
          }

          repositories.push(repositorySummary)
          continue
        }

        await mapWithConcurrencyLimit(
          eligibleAssets,
          maxParallelAssets,
          async ({ asset, existingRecord }) => {
            let downloadedAsset:
              | Awaited<ReturnType<GitHubReleaseSource['downloadAsset']>>
              | undefined

            logger.info?.(
              `[release-sync] Processing ${asset.assetName} (${formatBytes(asset.assetSize)}) for ${asset.repositoryKey}@${asset.releaseTagName}.`,
            )

            try {
              logger.info?.(`[release-sync] Downloading ${asset.assetName}...`)
              downloadedAsset = await options.source.downloadAsset(asset, { signal })
              const file = await describeFile(downloadedAsset.filePath)
              logger.info?.(
                `[release-sync] Downloaded ${asset.assetName}: ${formatBytes(file.byteSize)}, sha256=${file.sha256}.`,
              )

              if (existingRecord?.status === 'synced' && existingRecord.sha256 === file.sha256) {
                logger.info?.(
                  `[release-sync] Skipping ${asset.assetName}: local digest matches the existing manifest.`,
                )
                resultByAssetId.set(asset.assetId, {
                  asset,
                  outcome: createAssetOutcome({
                    asset,
                    status: 'skipped',
                    message: `Skipped ${asset.assetName} because the digest matches the existing manifest.`,
                    sha256: file.sha256,
                    providerName: existingRecord.providerName,
                    shareUrl: existingRecord.shareUrl,
                    failureStage: null,
                  }),
                  record: createRecordFromAttempt({
                    asset,
                    existingRecord,
                    sha256: file.sha256,
                    providerName: existingRecord.providerName,
                    remoteFileId: existingRecord.remoteFileId,
                    shareUrl: existingRecord.shareUrl,
                    status: 'synced',
                    attemptedAt: now().toISOString(),
                    failureStage: null,
                    failureMessage: null,
                  }),
                })
                return
              }

              try {
                logger.info?.(
                  `[release-sync] Uploading ${asset.assetName} to ${buildVersionedTargetDirectory(repository.targetDirectory, asset.releaseTagName) ?? '/'} through ${options.provider.providerName}...`,
                )
                const receipt = assertValidNetdiskUploadReceipt(
                  options.provider.providerName,
                  asset,
                  await options.provider.uploadAsset({
                    asset,
                    file,
                    destination: {
                      repositoryKey: repository.key,
                      targetDirectory: buildVersionedTargetDirectory(
                        repository.targetDirectory,
                        asset.releaseTagName,
                      ),
                    },
                    signal,
                  }),
                )

                resultByAssetId.set(asset.assetId, {
                  asset,
                  outcome: createAssetOutcome({
                    asset,
                    status: 'synced',
                    message: `Synced ${asset.assetName} through ${receipt.providerName}.`,
                    sha256: file.sha256,
                    providerName: receipt.providerName,
                    shareUrl: receipt.shareUrl,
                    failureStage: null,
                  }),
                  record: createRecordFromAttempt({
                    asset,
                    existingRecord,
                    sha256: file.sha256,
                    providerName: receipt.providerName,
                    remoteFileId: receipt.remoteFileId,
                    shareUrl: receipt.shareUrl,
                    status: 'synced',
                    attemptedAt: receipt.uploadedAt,
                    failureStage: null,
                    failureMessage: null,
                  }),
                })
                logger.info?.(
                  `[release-sync] Synced ${asset.assetName} through ${receipt.providerName}: ${receipt.shareUrl}`,
                )
              } catch (error) {
                const failure = normalizeNetdiskUploadError(
                  options.provider.providerName,
                  asset,
                  error,
                  now(),
                )
                logger.error?.(
                  `[release-sync] Upload failed for ${asset.assetName} (${failure.providerName}/${failure.stage}): ${failure.message}` +
                    formatDiagnosticsForLog(failure.diagnostics),
                )

                resultByAssetId.set(asset.assetId, {
                  asset,
                  outcome: createAssetOutcome({
                    asset,
                    status: 'upload_failed',
                    message: failure.message,
                    sha256: file.sha256,
                    providerName: failure.providerName,
                    shareUrl: existingRecord?.shareUrl ?? null,
                    failureStage: failure.stage,
                    failureOccurredAt: failure.occurredAt,
                    failureDiagnostics: failure.diagnostics ?? null,
                  }),
                  record: createRecordFromAttempt({
                    asset,
                    existingRecord,
                    sha256: file.sha256,
                    providerName: failure.providerName,
                    remoteFileId: existingRecord?.remoteFileId ?? null,
                    shareUrl: existingRecord?.shareUrl ?? null,
                    status: 'upload_failed',
                    attemptedAt: failure.occurredAt,
                    failureStage: failure.stage,
                    failureMessage: failure.message,
                    failureDiagnostics: failure.diagnostics ?? null,
                  }),
                })
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Unknown download error.'
              logger.error?.(
                `[release-sync] Download failed for ${asset.assetName}: ${message}` +
                  (error instanceof Error && error.stack ? `\n${error.stack}` : ''),
              )
              resultByAssetId.set(asset.assetId, {
                asset,
                outcome: createAssetOutcome({
                  asset,
                  status: 'download_failed',
                  message,
                  sha256: null,
                  providerName: existingRecord?.providerName ?? null,
                  shareUrl: existingRecord?.shareUrl ?? null,
                  failureStage: null,
                }),
                record: createRecordFromAttempt({
                  asset,
                  existingRecord,
                  sha256: null,
                  providerName: existingRecord?.providerName ?? null,
                  remoteFileId: existingRecord?.remoteFileId ?? null,
                  shareUrl: existingRecord?.shareUrl ?? null,
                  status: 'download_failed',
                  attemptedAt: now().toISOString(),
                  failureStage: null,
                  failureMessage: message,
                  failureDiagnostics: null,
                }),
              })
            } finally {
              try {
                await downloadedAsset?.cleanup()
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                logger.error?.(
                  `[release-sync] Failed to clean temporary asset directory for ${asset.repositoryKey}:${asset.assetName}: ${message}`,
                )
              }
            }
          },
        )

        if (manifest) {
          let nextManifest = manifest
          let hasManifestUpdates = false

          for (const { asset } of eligibleAssets) {
            const result = resultByAssetId.get(asset.assetId)
            if (!result?.record) {
              continue
            }

            hasManifestUpdates = true
            nextManifest = upsertManifestRecord(nextManifest, result.record)
          }

          if (hasManifestUpdates) {
            logger.info?.(
              `[release-sync] Persisting manifest for ${repository.key}@${nextManifest.releaseTagName ?? '<release-tag>'}...`,
            )
            try {
              manifest = await options.metadataStore.saveManifest(nextManifest)
              logger.info?.(
                `[release-sync] Manifest persisted for ${repository.key} (${(nextManifest.blobPath ?? 'in-memory')}).`,
              )
            } catch (error) {
              metadataPublicationFailure = normalizeMetadataFailure(error, nextManifest)
              logger.error?.(
                `[release-sync] Metadata publication failed for ${repository.key}: ${metadataPublicationFailure.message}`,
              )
            }
          }
        }

        for (const { asset } of eligibleAssets) {
          const result = resultByAssetId.get(asset.assetId)
          if (result) {
            addOutcome(repositorySummary, failures, result.outcome)
          }
        }

        logger.info?.(
          `[release-sync] Repository ${repository.key} done: ${repositorySummary.syncedCount} synced, ${repositorySummary.skippedCount} skipped, ${repositorySummary.failedCount} failed.`,
        )

        repositories.push(repositorySummary)
      }

      const finishedAt = now().toISOString()
      const totals = {
        discovered: repositories.reduce((t, r) => t + r.discoveredAssetCount, 0),
        processed: repositories.reduce((t, r) => t + r.processedAssetCount, 0),
        synced: repositories.reduce((t, r) => t + r.syncedCount, 0),
        skipped: repositories.reduce((t, r) => t + r.skippedCount, 0),
        failed: repositories.reduce((t, r) => t + r.failedCount, 0),
      }

      logger.info?.(
        `[release-sync] Run finished at ${finishedAt}: ${totals.synced} synced, ${totals.skipped} skipped, ${totals.failed} failed (${totals.discovered} discovered, ${totals.processed} processed).`,
      )

      if (totals.failed > 0 && failures.length > 0) {
        logger.error?.(`[release-sync] ${failures.length} failure(s) recorded:`)
        for (const failure of failures) {
          const stageSegment = failure.failureStage ? ` (${failure.failureStage})` : ''
          logger.error?.(
            `[release-sync]   - ${failure.assetName}${stageSegment}: ${failure.message}` +
              formatDiagnosticsForLog(failure.diagnostics),
          )
        }
      }

      if (metadataPublicationFailure) {
        logger.error?.(
          `[release-sync] Metadata publication failed for ${metadataPublicationFailure.repositoryKey}: ${metadataPublicationFailure.message}`,
        )
      }

      return {
        startedAt,
        finishedAt,
        providerName: options.provider.providerName,
        repositoryCount: options.source.targets.length,
        discoveredAssetCount: totals.discovered,
        processedAssetCount: totals.processed,
        syncedCount: totals.synced,
        skippedCount: totals.skipped,
        failedCount: totals.failed,
        repositories,
        failures,
        metadataPublicationFailure,
      }
    },
  }
}

export const createReleaseSyncService = createReleaseSyncRunner
