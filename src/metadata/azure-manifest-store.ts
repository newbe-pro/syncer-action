import { BlobServiceClient, ContainerClient } from '@azure/storage-blob'
import { Readable } from 'node:stream'
import {
  type MetadataPublicationFailure,
  type ReleaseSyncManifest,
  type ReleaseSyncManifestIndex,
  type ReleaseSyncManifestIndexReleaseEntry,
  type ReleaseSyncManifestIndexRepositoryEntry,
  type ReleaseSyncManifestIndexStatus,
  type ReleaseSyncRecord,
} from '../release-sync-contracts'

interface BlobDownloadResponseLike {
  etag?: string
  readableStreamBody?: NodeJS.ReadableStream | Readable | null
}

interface BlockBlobClientLike {
  download(): Promise<BlobDownloadResponseLike>
  uploadData(
    data: Uint8Array,
    options?: { blobHTTPHeaders?: { blobContentType?: string } },
  ): Promise<{ etag?: string }>
}

interface ContainerClientLike {
  createIfNotExists(): Promise<unknown>
  getBlockBlobClient(blobName: string): BlockBlobClientLike
  listBlobsFlat?(options?: {
    prefix?: string
  }): AsyncIterable<{
    name: string
    properties?: {
      lastModified?: Date | null
    }
  }>
}

type AzureBlobAuthorizationCategory = '权限不足' | '网络限制' | 'SAS 失效/签名问题'

interface AzureBlobAuthorizationDiagnosis {
  category: AzureBlobAuthorizationCategory
  hint: string
}

export interface ReleaseSyncMetadataStore {
  loadManifest(repositoryKey: string, releaseTagName?: string): Promise<ReleaseSyncManifest>
  loadManifestIndex(): Promise<ReleaseSyncManifestIndex>
  saveManifest(manifest: ReleaseSyncManifest): Promise<ReleaseSyncManifest>
}

export class MetadataPublicationError extends Error {
  readonly details: MetadataPublicationFailure

  constructor(details: MetadataPublicationFailure, options?: { cause?: unknown }) {
    super(details.message, options)
    this.name = 'MetadataPublicationError'
    this.details = details
  }
}

function readStreamAsString(stream: NodeJS.ReadableStream | Readable | null | undefined) {
  if (!stream) {
    return Promise.resolve('')
  }

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function createEmptyManifest(
  repositoryKey: string,
  now: Date,
  releaseTagName?: string | null,
  blobPath?: string,
): ReleaseSyncManifest {
  return {
    repositoryKey,
    releaseTagName: releaseTagName ?? null,
    version: 1,
    updatedAt: now.toISOString(),
    records: [],
    blobPath,
  }
}

export function buildReleaseSyncManifestIndexBlobName(prefix = 'release-sync') {
  return `${prefix.replace(/\/+$/, '')}/index.json`
}

export function createEmptyReleaseSyncManifestIndex(
  now: Date,
  prefix = 'release-sync',
): ReleaseSyncManifestIndex {
  return {
    version: 1,
    updatedAt: now.toISOString(),
    repositories: [],
    blobPath: buildReleaseSyncManifestIndexBlobName(prefix),
  }
}

function normalizeManifest(
  repositoryKey: string,
  records: ReleaseSyncRecord[],
  updatedAt: string,
  etag?: string,
  releaseTagName?: string | null,
  blobPath?: string,
): ReleaseSyncManifest {
  return {
    repositoryKey,
    releaseTagName: releaseTagName ?? null,
    version: 1,
    updatedAt,
    records,
    etag,
    blobPath,
  }
}

function normalizeManifestIndex(
  index: Partial<ReleaseSyncManifestIndex> | undefined,
  defaultUpdatedAt: string,
  blobPath: string,
  etag?: string,
): ReleaseSyncManifestIndex {
  return {
    version: 1,
    updatedAt: index?.updatedAt ?? defaultUpdatedAt,
    repositories: Array.isArray(index?.repositories) ? index.repositories : [],
    etag,
    blobPath,
  }
}

function isNotFoundError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false
  }

  return (
    ('statusCode' in error || 'code' in error) &&
    ((error as { statusCode?: number }).statusCode === 404 ||
      (error as { code?: string }).code === 'BlobNotFound')
  )
}

function getErrorStatusCode(error: unknown) {
  if (!error || typeof error !== 'object') {
    return undefined
  }

  return typeof (error as { statusCode?: unknown }).statusCode === 'number'
    ? (error as { statusCode: number }).statusCode
    : undefined
}

function getErrorCode(error: unknown) {
  if (!error || typeof error !== 'object') {
    return undefined
  }

  return typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function formatIsoDate(value: string) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return parsed.toISOString()
}

function compareIsoStrings(left: string | null | undefined, right: string | null | undefined) {
  if (left === right) {
    return 0
  }

  if (!left) {
    return -1
  }

  if (!right) {
    return 1
  }

  const leftTime = Date.parse(left)
  const rightTime = Date.parse(right)
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime
  }

  return left.localeCompare(right)
}

function maxIsoString(left: string | null | undefined, right: string | null | undefined) {
  return compareIsoStrings(left, right) >= 0 ? left ?? null : right ?? null
}

function parseRepositoryIdentity(repositoryKey: string) {
  const [owner = repositoryKey, repo = repositoryKey] = repositoryKey.split('/', 2)
  return {
    owner,
    repo,
    displayName: repositoryKey,
  }
}

function compareReleaseSyncRecords(left: ReleaseSyncRecord, right: ReleaseSyncRecord) {
  return (
    compareIsoStrings(left.lastAttemptedAt, right.lastAttemptedAt) ||
    compareIsoStrings(left.lastSyncedAt, right.lastSyncedAt) ||
    left.releaseId - right.releaseId ||
    left.assetId - right.assetId ||
    left.assetName.localeCompare(right.assetName) ||
    left.status.localeCompare(right.status)
  )
}

function summarizeManifestStatus(records: ReleaseSyncRecord[]): {
  status: ReleaseSyncManifestIndexStatus
  lastAttemptedAt: string | null
  lastSuccessfulAt: string | null
} {
  if (records.length === 0) {
    return {
      status: 'awaiting_evidence',
      lastAttemptedAt: null,
      lastSuccessfulAt: null,
    }
  }

  const latestAttemptedRecord = records.reduce((latest, record) =>
    compareReleaseSyncRecords(record, latest) > 0 ? record : latest,
  )
  const lastSuccessfulAt = records.reduce<string | null>(
    (latest, record) => maxIsoString(latest, record.lastSyncedAt),
    null,
  )

  return {
    status: latestAttemptedRecord.status === 'synced' ? 'synced' : 'failed',
    lastAttemptedAt: latestAttemptedRecord.lastAttemptedAt,
    lastSuccessfulAt,
  }
}

function summarizeManifestForReleaseEntry(
  manifest: ReleaseSyncManifest,
): ReleaseSyncManifestIndexReleaseEntry {
  const releaseTagName = manifest.releaseTagName?.trim()
  if (!releaseTagName) {
    throw new Error(
      `A releaseTagName is required to summarize the manifest for ${manifest.repositoryKey}.`,
    )
  }

  const { owner, repo, displayName } = parseRepositoryIdentity(manifest.repositoryKey)
  const { status, lastAttemptedAt, lastSuccessfulAt } = summarizeManifestStatus(manifest.records)

  return {
    repositoryKey: manifest.repositoryKey,
    owner,
    repo,
    displayName,
    releaseTagName,
    manifestPath: manifest.blobPath ?? buildReleaseSyncManifestBlobName(manifest.repositoryKey),
    recordCount: manifest.records.length,
    updatedAt: manifest.updatedAt,
    lastAttemptedAt,
    lastSuccessfulAt,
    status,
  }
}

function compareManifestIndexReleaseEntries(
  left: ReleaseSyncManifestIndexReleaseEntry,
  right: ReleaseSyncManifestIndexReleaseEntry,
) {
  return (
    left.releaseTagName.localeCompare(right.releaseTagName) ||
    left.manifestPath.localeCompare(right.manifestPath)
  )
}

function compareManifestIndexRepositoryEntries(
  left: ReleaseSyncManifestIndexRepositoryEntry,
  right: ReleaseSyncManifestIndexRepositoryEntry,
) {
  return left.repositoryKey.localeCompare(right.repositoryKey)
}

function summarizeRepositoryEntry(
  repositoryKey: string,
  releases: ReleaseSyncManifestIndexReleaseEntry[],
): ReleaseSyncManifestIndexRepositoryEntry {
  const firstRelease = releases[0]
  if (!firstRelease) {
    throw new Error(
      `At least one release summary is required to summarize repository ${repositoryKey}.`,
    )
  }

  const sortedReleases = [...releases].sort(compareManifestIndexReleaseEntries)
  const latestRelease = releases.reduce((latest, release) => {
    if (!latest) {
      return release
    }

    return compareIsoStrings(release.lastAttemptedAt, latest.lastAttemptedAt) > 0
      ? release
      : compareIsoStrings(release.lastAttemptedAt, latest.lastAttemptedAt) === 0 &&
          compareIsoStrings(release.updatedAt, latest.updatedAt) > 0
        ? release
        : compareIsoStrings(release.lastAttemptedAt, latest.lastAttemptedAt) === 0 &&
            compareIsoStrings(release.updatedAt, latest.updatedAt) === 0 &&
            compareManifestIndexReleaseEntries(release, latest) > 0
          ? release
          : latest
  }, firstRelease)
  const { owner, repo, displayName } = parseRepositoryIdentity(repositoryKey)

  return {
    repositoryKey,
    owner,
    repo,
    displayName,
    releaseTagName: latestRelease.releaseTagName,
    manifestPath: latestRelease.manifestPath,
    recordCount: latestRelease.recordCount,
    updatedAt: latestRelease.updatedAt,
    lastAttemptedAt: latestRelease.lastAttemptedAt,
    lastSuccessfulAt: sortedReleases.reduce<string | null>(
      (latest, release) => maxIsoString(latest, release.lastSuccessfulAt),
      null,
    ),
    status: latestRelease.status,
    releases: sortedReleases,
  }
}

function upsertManifestIndexRepository(
  index: ReleaseSyncManifestIndex,
  manifest: ReleaseSyncManifest,
  updatedAt: string,
  blobPath: string,
): ReleaseSyncManifestIndex {
  const nextRelease = summarizeManifestForReleaseEntry(manifest)
  const existingRepository = index.repositories.find(
    (entry) => entry.repositoryKey === manifest.repositoryKey,
  )
  const nextReleases = [
    ...(existingRepository?.releases.filter(
      (release) => release.releaseTagName !== nextRelease.releaseTagName,
    ) ?? []),
    nextRelease,
  ]
  const nextRepository = summarizeRepositoryEntry(manifest.repositoryKey, nextReleases)
  const repositories = [
    ...index.repositories.filter((entry) => entry.repositoryKey !== manifest.repositoryKey),
    nextRepository,
  ].sort(compareManifestIndexRepositoryEntries)

  return {
    version: 1,
    updatedAt,
    repositories,
    blobPath,
  }
}

function diagnoseAzureBlobAuthorizationError(
  error: unknown,
  options: {
    containerSasUrl?: string
    now: () => Date
  },
): AzureBlobAuthorizationDiagnosis | null {
  const statusCode = getErrorStatusCode(error)
  const code = getErrorCode(error)

  if (
    statusCode !== 403 &&
    code !== 'AuthenticationFailed' &&
    code !== 'InvalidAuthenticationInfo'
  ) {
    return null
  }

  const sasUrl = options.containerSasUrl?.trim()
  if (sasUrl) {
    const query = new URL(sasUrl).searchParams
    const startsAt = query.get('st')
    const expiresAt = query.get('se')
    const now = options.now()

    if (startsAt) {
      const startTime = new Date(startsAt)
      if (!Number.isNaN(startTime.getTime()) && now < startTime) {
        return {
          category: 'SAS 失效/签名问题',
          hint: `当前 SAS 尚未生效（st=${formatIsoDate(startsAt)}）。请检查 SAS 开始时间、时钟偏差或重新生成签名。`,
        }
      }
    }

    if (expiresAt) {
      const expiryTime = new Date(expiresAt)
      if (!Number.isNaN(expiryTime.getTime()) && now > expiryTime) {
        return {
          category: 'SAS 失效/签名问题',
          hint: `当前 SAS 已过期（se=${formatIsoDate(expiresAt)}）。请重新生成容器级 SAS。`,
        }
      }
    }
  }

  if (code === 'AuthenticationFailed' || code === 'InvalidAuthenticationInfo') {
    return {
      category: 'SAS 失效/签名问题',
      hint: 'Azure 拒绝了当前 SAS 签名。请检查 sig、sv、sr=c，以及 SAS 是否已被重新生成或撤销。',
    }
  }

  if (
    code === 'AuthorizationPermissionMismatch' ||
    code === 'AuthorizationServiceMismatch' ||
    code === 'InsufficientAccountPermissions'
  ) {
    return {
      category: '权限不足',
      hint: '请确认容器级 SAS 至少包含 create/list/read/write 权限，并且允许当前操作访问该容器。',
    }
  }

  if (code === 'AuthorizationFailure' || code === 'IpAddressNotInRange') {
    return {
      category: '网络限制',
      hint: 'Azure Storage 很可能启用了防火墙、IP 白名单、专用网络或受信任服务限制。请检查当前出口 IP 与存储账号网络规则。',
    }
  }

  return {
    category: '权限不足',
    hint: 'Azure 返回了授权失败。请优先检查 SAS 权限范围、容器级别授权和存储账号访问策略。',
  }
}

function normalizeAzureBlobMetadataError(
  error: unknown,
  options: {
    operation: string
    containerSasUrl?: string
    now: () => Date
  },
) {
  const diagnosis = diagnoseAzureBlobAuthorizationError(error, {
    containerSasUrl: options.containerSasUrl,
    now: options.now,
  })

  if (!diagnosis) {
    return error instanceof Error
      ? error
      : new Error(`Azure Blob ${options.operation} failed: ${getErrorMessage(error)}`)
  }

  return new Error(
    `Azure Blob ${options.operation} failed [${diagnosis.category}]：${diagnosis.hint} 原始错误：${getErrorMessage(error)}`,
  )
}

export function buildReleaseSyncManifestBlobPrefix(
  repositoryKey: string,
  prefix = 'release-sync',
) {
  const [owner, repo] = repositoryKey.split('/')
  return `${prefix.replace(/\/+$/, '')}/${owner}/${repo}`
}

export function buildReleaseSyncManifestBlobName(
  repositoryKey: string,
  prefix = 'release-sync',
  releaseTagName?: string | null,
) {
  const repositoryPrefix = buildReleaseSyncManifestBlobPrefix(repositoryKey, prefix)

  if (!releaseTagName?.trim()) {
    return `${repositoryPrefix}/<release-tag>/manifest.json`
  }

  return `${repositoryPrefix}/${releaseTagName}/manifest.json`
}

function extractReleaseTagNameFromBlobName(
  repositoryKey: string,
  prefix: string,
  blobName: string,
) {
  const repositoryPrefix = `${buildReleaseSyncManifestBlobPrefix(repositoryKey, prefix)}/`
  const manifestSuffix = '/manifest.json'

  if (!blobName.startsWith(repositoryPrefix) || !blobName.endsWith(manifestSuffix)) {
    return null
  }

  const releaseTagName = blobName.slice(
    repositoryPrefix.length,
    blobName.length - manifestSuffix.length,
  )

  return releaseTagName || null
}

async function findLatestManifestBlobName(
  repositoryKey: string,
  prefix: string,
  containerClient: ContainerClientLike,
) {
  const listBlobsFlat = containerClient.listBlobsFlat?.bind(containerClient)
  if (!listBlobsFlat) {
    return undefined
  }

  const repositoryPrefix = `${buildReleaseSyncManifestBlobPrefix(repositoryKey, prefix)}/`
  let latestBlob:
    | {
        name: string
        lastModified: number
      }
    | undefined

  for await (const blob of listBlobsFlat({ prefix: repositoryPrefix })) {
    if (!blob.name.endsWith('/manifest.json')) {
      continue
    }

    const lastModified = blob.properties?.lastModified?.getTime() ?? Number.NEGATIVE_INFINITY
    if (
      !latestBlob ||
      lastModified > latestBlob.lastModified ||
      (lastModified === latestBlob.lastModified && blob.name > latestBlob.name)
    ) {
      latestBlob = {
        name: blob.name,
        lastModified,
      }
    }
  }

  return latestBlob?.name
}

export function createAzureBlobContainerClient(options: {
  connectionString?: string
  containerName?: string
  containerSasUrl?: string
}) {
  if (options.containerSasUrl?.trim()) {
    return new ContainerClient(options.containerSasUrl.trim())
  }

  if (options.connectionString?.trim() && options.containerName?.trim()) {
    return BlobServiceClient.fromConnectionString(options.connectionString).getContainerClient(
      options.containerName,
    )
  }

  throw new Error(
    'AZURE_STORAGE_BLOB_SAS_URL or AZURE_STORAGE_CONNECTION_STRING is required when no custom container client is provided.',
  )
}

export function createAzureManifestStore(options: {
  connectionString?: string
  containerName?: string
  containerSasUrl?: string
  prefix?: string
  now?: () => Date
  containerClient?: ContainerClientLike
}): ReleaseSyncMetadataStore {
  const now = options.now ?? (() => new Date())
  const containerClient =
    options.containerClient ??
    createAzureBlobContainerClient({
      connectionString: options.connectionString,
      containerName: options.containerName,
      containerSasUrl: options.containerSasUrl,
    })
  const prefix = options.prefix ?? 'release-sync'
  const shouldEnsureContainerExists = !options.containerSasUrl?.trim()

  async function getBlobClient(blobName: string) {
    if (shouldEnsureContainerExists) {
      try {
        await containerClient.createIfNotExists()
      } catch (error) {
        throw normalizeAzureBlobMetadataError(error, {
          operation: 'container preflight',
          containerSasUrl: options.containerSasUrl,
          now,
        })
      }
    }

    return containerClient.getBlockBlobClient(blobName)
  }

  async function loadManifestIndexInternal() {
    const blobPath = buildReleaseSyncManifestIndexBlobName(prefix)
    const blobClient = await getBlobClient(blobPath)

    try {
      const response = await blobClient.download()
      const contents = await readStreamAsString(response.readableStreamBody)

      if (!contents.trim()) {
        return createEmptyReleaseSyncManifestIndex(now(), prefix)
      }

      return normalizeManifestIndex(
        JSON.parse(contents) as Partial<ReleaseSyncManifestIndex>,
        now().toISOString(),
        blobPath,
        response.etag,
      )
    } catch (error) {
      if (isNotFoundError(error)) {
        return createEmptyReleaseSyncManifestIndex(now(), prefix)
      }

      throw normalizeAzureBlobMetadataError(error, {
        operation: 'root manifest index download',
        containerSasUrl: options.containerSasUrl,
        now,
      })
    }
  }

  return {
    async loadManifest(repositoryKey, releaseTagName) {
      const blobName =
        releaseTagName?.trim()
          ? buildReleaseSyncManifestBlobName(repositoryKey, prefix, releaseTagName)
          : await findLatestManifestBlobName(repositoryKey, prefix, containerClient)

      if (!blobName) {
        return createEmptyManifest(
          repositoryKey,
          now(),
          releaseTagName ?? null,
          buildReleaseSyncManifestBlobName(repositoryKey, prefix, releaseTagName),
        )
      }

      const blobClient = await getBlobClient(blobName)
      const resolvedReleaseTagName =
        releaseTagName ?? extractReleaseTagNameFromBlobName(repositoryKey, prefix, blobName)

      try {
        const response = await blobClient.download()
        const contents = await readStreamAsString(response.readableStreamBody)

        if (!contents.trim()) {
          return createEmptyManifest(repositoryKey, now(), resolvedReleaseTagName, blobName)
        }

        const parsed = JSON.parse(contents) as {
          releaseTagName?: string | null
          updatedAt?: string
          records?: ReleaseSyncRecord[]
        }

        return normalizeManifest(
          repositoryKey,
          parsed.records ?? [],
          parsed.updatedAt ?? now().toISOString(),
          response.etag,
          parsed.releaseTagName ?? resolvedReleaseTagName ?? null,
          blobName,
        )
      } catch (error) {
        if (isNotFoundError(error)) {
          return createEmptyManifest(repositoryKey, now(), resolvedReleaseTagName, blobName)
        }

        throw normalizeAzureBlobMetadataError(error, {
          operation: `manifest download for ${repositoryKey}`,
          containerSasUrl: options.containerSasUrl,
          now,
        })
      }
    },
    async loadManifestIndex() {
      return loadManifestIndexInternal()
    },
    async saveManifest(manifest) {
      const releaseTagName = manifest.releaseTagName?.trim()
      if (!releaseTagName) {
        throw new Error(
          `A releaseTagName is required to persist the manifest for ${manifest.repositoryKey}.`,
        )
      }

      const blobPath = buildReleaseSyncManifestBlobName(
        manifest.repositoryKey,
        prefix,
        releaseTagName,
      )
      const blobClient = await getBlobClient(blobPath)
      const nextManifest = {
        ...manifest,
        releaseTagName,
        version: 1,
        updatedAt: now().toISOString(),
        blobPath,
      }
      const payload = Buffer.from(JSON.stringify(nextManifest, null, 2))
      let response: { etag?: string }

      try {
        response = await blobClient.uploadData(payload, {
          blobHTTPHeaders: {
            blobContentType: 'application/json; charset=utf-8',
          },
        })
      } catch (error) {
        throw normalizeAzureBlobMetadataError(error, {
          operation: `manifest upload for ${manifest.repositoryKey}`,
          containerSasUrl: options.containerSasUrl,
          now,
        })
      }

      const persistedManifest = {
        ...nextManifest,
        etag: response.etag ?? nextManifest.etag,
      }
      const indexBlobPath = buildReleaseSyncManifestIndexBlobName(prefix)

      try {
        const currentIndex = await loadManifestIndexInternal()
        const refreshedIndex = upsertManifestIndexRepository(
          currentIndex,
          persistedManifest,
          now().toISOString(),
          indexBlobPath,
        )
        const indexBlobClient = await getBlobClient(indexBlobPath)

        await indexBlobClient.uploadData(Buffer.from(JSON.stringify(refreshedIndex, null, 2)), {
          blobHTTPHeaders: {
            blobContentType: 'application/json; charset=utf-8',
          },
        })
      } catch (error) {
        const normalizedError = normalizeAzureBlobMetadataError(error, {
          operation: `root manifest index refresh for ${manifest.repositoryKey}`,
          containerSasUrl: options.containerSasUrl,
          now,
        })

        throw new MetadataPublicationError(
          {
            repositoryKey: manifest.repositoryKey,
            message: `Failed to refresh root manifest index for ${manifest.repositoryKey} after persisting repository manifest ${blobPath}. Root index path: ${indexBlobPath}. Original error: ${normalizedError.message}`,
            manifestPath: blobPath,
            rootIndexPath: indexBlobPath,
            manifestPersisted: true,
            occurredAt: now().toISOString(),
          },
          { cause: normalizedError },
        )
      }

      return persistedManifest
    },
  }
}

export const createReleaseSyncMetadataStore = createAzureManifestStore
