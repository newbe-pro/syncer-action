import {
  type GitHubReleaseAsset,
  type NetdiskFailureDiagnostics,
  type NetdiskFailureStage,
  type NetdiskUploadFailure,
  type NetdiskUploadReceipt,
  type NetdiskUploadRequest,
} from './release-sync-contracts'

const maxRecentRetryLogs = 3

export interface NetdiskProvider {
  providerName: string
  uploadAsset(request: NetdiskUploadRequest): Promise<NetdiskUploadReceipt>
}

function formatNetdiskUploadFailureMessage(
  providerName: string,
  stage: NetdiskFailureStage,
  asset: GitHubReleaseAsset,
  message: string,
) {
  return `${providerName} ${stage} failed for ${asset.repositoryKey}:${asset.assetName}: ${message}`
}

function normalizeFailureDiagnostics(
  diagnostics: NetdiskFailureDiagnostics | undefined,
): NetdiskFailureDiagnostics | undefined {
  if (!diagnostics) {
    return undefined
  }

  const recentLogs = diagnostics.retry?.recentLogs?.slice(0, maxRecentRetryLogs)

  return {
    ...diagnostics,
    ...(diagnostics.retry
      ? {
          retry: {
            ...diagnostics.retry,
            ...(recentLogs ? { recentLogs } : {}),
          },
        }
      : {}),
  }
}

export class NetdiskProviderError extends Error {
  readonly providerName: string
  readonly stage: NetdiskFailureStage
  readonly repositoryKey: string
  readonly releaseId: number
  readonly assetId: number
  readonly assetName: string
  readonly diagnostics?: NetdiskFailureDiagnostics

  constructor(options: {
    providerName: string
    stage: NetdiskFailureStage
    asset: GitHubReleaseAsset
    message: string
    cause?: unknown
    diagnostics?: NetdiskFailureDiagnostics
  }) {
    super(
      formatNetdiskUploadFailureMessage(
        options.providerName,
        options.stage,
        options.asset,
        options.message,
      ),
      options.cause ? { cause: options.cause } : undefined,
    )
    this.name = 'NetdiskProviderError'
    this.providerName = options.providerName
    this.stage = options.stage
    this.repositoryKey = options.asset.repositoryKey
    this.releaseId = options.asset.releaseId
    this.assetId = options.asset.assetId
    this.assetName = options.asset.assetName
    this.diagnostics = normalizeFailureDiagnostics(options.diagnostics)
  }
}

export function createNetdiskProviderError(options: {
  providerName: string
  stage: NetdiskFailureStage
  asset: GitHubReleaseAsset
  error: unknown
  diagnostics?: NetdiskFailureDiagnostics
}) {
  if (options.error instanceof NetdiskProviderError) {
    if (!options.error.diagnostics && options.diagnostics) {
      return new NetdiskProviderError({
        providerName: options.error.providerName,
        stage: options.error.stage,
        asset: options.asset,
        message: options.error.message,
        cause: options.error.cause,
        diagnostics: options.diagnostics,
      })
    }
    return options.error
  }

  const message =
    options.error instanceof Error
      ? options.error.message
      : typeof options.error === 'string'
        ? options.error
        : 'Unknown netdisk upload error.'

  return new NetdiskProviderError({
    providerName: options.providerName,
    stage: options.stage,
    asset: options.asset,
    message,
    cause: options.error,
    diagnostics: options.diagnostics,
  })
}

export function normalizeNetdiskUploadError(
  providerName: string,
  asset: GitHubReleaseAsset,
  error: unknown,
  occurredAt = new Date(),
): NetdiskUploadFailure {
  const normalizedError =
    error instanceof NetdiskProviderError
      ? error
      : createNetdiskProviderError({
          providerName,
          stage: 'upload',
          asset,
          error,
        })

  return {
    providerName: normalizedError.providerName,
    repositoryKey: normalizedError.repositoryKey,
    releaseId: normalizedError.releaseId,
    assetId: normalizedError.assetId,
    assetName: normalizedError.assetName,
    stage: normalizedError.stage,
    message: normalizedError.message,
    occurredAt: occurredAt.toISOString(),
    diagnostics: normalizeFailureDiagnostics(normalizedError.diagnostics),
  }
}

export function assertValidNetdiskUploadReceipt(
  providerName: string,
  asset: GitHubReleaseAsset,
  receipt: NetdiskUploadReceipt,
) {
  if (!receipt.remoteFileId.trim()) {
    throw new NetdiskProviderError({
      providerName,
      stage: 'upload',
      asset,
      message: 'Provider returned an empty remoteFileId.',
    })
  }

  if (!receipt.shareUrl.trim()) {
    throw new NetdiskProviderError({
      providerName,
      stage: 'share',
      asset,
      message: 'Provider returned an empty shareUrl.',
    })
  }

  return receipt
}
