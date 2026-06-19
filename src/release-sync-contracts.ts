export type NetdiskFailureStage =
  | 'auth'
  | 'directory'
  | 'upload'
  | 'share'
  | 'configuration'
  | 'unknown'

export type NetdiskErrorDetailLevel = 'diagnostic' | 'summary'

export interface NetdiskFailureRequestDiagnostics {
  method?: string
  host?: string | null
  path?: string | null
  query?: string | null
}

export interface NetdiskFailureResponseDiagnostics {
  status?: number | null
  statusText?: string | null
  headers?: Record<string, string>
  bodyExcerpt?: string | null
}

export interface NetdiskFailureProviderDiagnostics {
  code?: string | number | null
  message?: string | null
}

export interface NetdiskFailureTransportDiagnostics {
  type?: 'network' | 'invalid_json' | 'unknown'
  message?: string | null
  causes?: string[]
}

export interface NetdiskFailureRetryDiagnostics {
  attempts?: number
  maxAttempts?: number
  intervalMs?: number
  recentLogs?: NetdiskFailureRecentLogEntry[]
}

export interface NetdiskFailureRecentLogEntry {
  occurredAt: string
  attempt?: number
  httpStatus?: number | null
  statusText?: string | null
  message: string
  uploadedBytes?: number | null
  totalBytes?: number | null
}

export interface NetdiskFailureRedactionDiagnostics {
  mode: 'sanitized'
  headersRedacted?: string[]
  queryRedacted?: boolean
  bodyTruncated?: boolean
}

export interface NetdiskFailureDiagnostics {
  detailLevel: NetdiskErrorDetailLevel
  request?: NetdiskFailureRequestDiagnostics
  response?: NetdiskFailureResponseDiagnostics
  provider?: NetdiskFailureProviderDiagnostics
  transport?: NetdiskFailureTransportDiagnostics
  retry?: NetdiskFailureRetryDiagnostics
  redaction?: NetdiskFailureRedactionDiagnostics
}

export interface GitHubReleaseAsset {
  repositoryKey: string
  releaseId: number
  releaseTagName: string
  releaseName: string | null
  releasePublishedAt: string | null
  latestReleaseId: number
  latestReleaseTagName: string
  latestReleasePublishedAt: string | null
  assetId: number
  assetName: string
  assetSize: number
  browserDownloadUrl: string
  assetUpdatedAt: string
}

export interface DownloadedReleaseAsset {
  asset: GitHubReleaseAsset
  filePath: string
  byteSize: number
  cleanup(): Promise<void>
}

export interface LocalFileMetadata {
  filePath: string
  byteSize: number
  sha256: string
  md5: string
}

export interface NetdiskUploadDestination {
  repositoryKey: string
  targetDirectory?: string
}

export interface NetdiskUploadRequest {
  asset: GitHubReleaseAsset
  file: LocalFileMetadata
  destination: NetdiskUploadDestination
  signal?: AbortSignal
}

export interface NetdiskUploadReceipt {
  providerName: string
  remoteFileId: string
  shareUrl: string
  uploadedAt: string
}

export interface NetdiskUploadFailure {
  providerName: string
  repositoryKey: string
  releaseId: number
  assetId: number
  assetName: string
  stage: NetdiskFailureStage
  message: string
  occurredAt: string
  diagnostics?: NetdiskFailureDiagnostics
}

export type ReleaseSyncRecordStatus = 'synced' | 'download_failed' | 'upload_failed'

export interface ReleaseSyncRecord {
  repositoryKey: string
  releaseId: number
  releaseTagName: string
  assetId: number
  assetName: string
  assetSize: number
  assetUpdatedAt: string
  sourceDownloadUrl: string
  sha256: string | null
  providerName: string | null
  remoteFileId: string | null
  shareUrl: string | null
  status: ReleaseSyncRecordStatus
  firstSyncedAt: string | null
  lastSyncedAt: string | null
  lastAttemptedAt: string
  failureStage: NetdiskFailureStage | null
  failureMessage: string | null
  failureDiagnostics?: NetdiskFailureDiagnostics | null
}

export interface ReleaseSyncManifest {
  repositoryKey: string
  releaseTagName?: string | null
  version: number
  updatedAt: string
  records: ReleaseSyncRecord[]
  etag?: string
  blobPath?: string
}

export type ReleaseSyncManifestIndexStatus = 'synced' | 'failed' | 'awaiting_evidence'

export interface ReleaseSyncManifestIndexReleaseEntry {
  repositoryKey: string
  owner: string
  repo: string
  displayName: string
  releaseTagName: string
  manifestPath: string
  recordCount: number
  updatedAt: string
  lastAttemptedAt: string | null
  lastSuccessfulAt: string | null
  status: ReleaseSyncManifestIndexStatus
}

export interface ReleaseSyncManifestIndexRepositoryEntry {
  repositoryKey: string
  owner: string
  repo: string
  displayName: string
  releaseTagName: string
  manifestPath: string
  recordCount: number
  updatedAt: string
  lastAttemptedAt: string | null
  lastSuccessfulAt: string | null
  status: ReleaseSyncManifestIndexStatus
  releases: ReleaseSyncManifestIndexReleaseEntry[]
}

export interface ReleaseSyncManifestIndex {
  version: number
  updatedAt: string
  repositories: ReleaseSyncManifestIndexRepositoryEntry[]
  etag?: string
  blobPath?: string
}

export type ReleaseSyncAssetOutcomeStatus =
  | ReleaseSyncRecordStatus
  | 'skipped'
  | 'metadata_failed'

export interface ReleaseSyncAssetOutcome {
  repositoryKey: string
  releaseId: number
  assetId: number
  assetName: string
  status: ReleaseSyncAssetOutcomeStatus
  message: string
  sha256: string | null
  providerName: string | null
  shareUrl: string | null
  failureStage: NetdiskFailureStage | null
  failureOccurredAt?: string | null
  failureDiagnostics?: NetdiskFailureDiagnostics | null
}

export interface ReleaseSyncRepositorySummary {
  repositoryKey: string
  discoveredAssetCount: number
  processedAssetCount: number
  syncedCount: number
  skippedCount: number
  failedCount: number
  outcomes: ReleaseSyncAssetOutcome[]
}

export interface ReleaseSyncRunFailure {
  repositoryKey: string
  releaseId: number
  assetId: number
  assetName: string
  providerName: string | null
  failureStage: NetdiskFailureStage | null
  message: string
  occurredAt?: string | null
  diagnostics?: NetdiskFailureDiagnostics | null
}

export interface MetadataPublicationFailure {
  repositoryKey: string
  message: string
  manifestPath: string
  rootIndexPath: string
  manifestPersisted: boolean
  occurredAt: string
}

export type WorkflowRunConclusion =
  | 'success'
  | 'noop'
  | 'partial_failure'
  | 'failure'

export interface ReleaseSyncRunSummary {
  startedAt: string
  finishedAt: string
  providerName: string | null
  repositoryCount: number
  discoveredAssetCount: number
  processedAssetCount: number
  syncedCount: number
  skippedCount: number
  failedCount: number
  repositories: ReleaseSyncRepositorySummary[]
  failures: ReleaseSyncRunFailure[]
  metadataPublicationFailure?: MetadataPublicationFailure | null
}

export interface ReleaseSyncJobResult {
  repositoryKey: string
  targetName: string
  providerName: string | null
  conclusion: WorkflowRunConclusion
  summary: ReleaseSyncRunSummary
  generatedAt: string
}
