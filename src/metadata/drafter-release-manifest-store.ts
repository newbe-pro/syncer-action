import {
  type MetadataPublicationFailure,
  type ReleaseSyncManifest,
  type ReleaseSyncManifestIndex,
  type ReleaseSyncManifestIndexReleaseEntry,
  type ReleaseSyncManifestIndexRepositoryEntry,
  type ReleaseSyncManifestIndexStatus,
  type ReleaseSyncRecord,
} from '../release-sync-contracts'

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

const ASSET_PATH_SEPARATOR = '__'

export interface DraftReleaseRef {
  id: number
  tagName: string
  createdAt: string
  htmlUrl?: string
}

export interface ReleaseAssetRef {
  id: number
  name: string
  size: number
  url: string
  browserDownloadUrl?: string
  updatedAt?: string
}

export interface DrafterReleaseGitHubClient {
  listReleases(): Promise<
    Array<{
      id: number
      tag_name: string
      draft: boolean
      created_at: string
      html_url?: string
    }>
  >
  listReleaseAssets(releaseId: number): Promise<ReleaseAssetRef[]>
  downloadAsset(asset: ReleaseAssetRef): Promise<string>
  deleteAsset(assetId: number): Promise<void>
  uploadReleaseAsset(releaseId: number, assetName: string, body: Buffer | string): Promise<ReleaseAssetRef>
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


function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
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
  releaseTagName: string,
  records: ReleaseSyncRecord[],
): ReleaseSyncManifestIndexReleaseEntry {
  const { owner, repo, displayName } = parseRepositoryIdentity(manifest.repositoryKey)
  const { status, lastAttemptedAt, lastSuccessfulAt } = summarizeManifestStatus(records)
  const manifestPath =
    manifest.blobPath ?? buildReleaseSyncManifestBlobName(manifest.repositoryKey)

  return {
    repositoryKey: manifest.repositoryKey,
    owner,
    repo,
    displayName,
    releaseTagName,
    manifestPath,
    recordCount: records.length,
    updatedAt: manifest.updatedAt,
    lastAttemptedAt,
    lastSuccessfulAt,
    status,
  }
}

function groupManifestRecordsByReleaseTag(records: ReleaseSyncRecord[]) {
  const groups = new Map<string, ReleaseSyncRecord[]>()
  for (const record of records) {
    const tag = record.releaseTagName?.trim()
    if (!tag) {
      continue
    }
    const existing = groups.get(tag)
    if (existing) {
      existing.push(record)
    } else {
      groups.set(tag, [record])
    }
  }
  return groups
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
  const grouped = groupManifestRecordsByReleaseTag(manifest.records)
  const releaseTags = [...grouped.keys()]
  if (releaseTags.length === 0) {
    const fallbackTag = manifest.releaseTagName?.trim()
    if (!fallbackTag) {
      throw new Error(
        `A releaseTagName is required to summarize the manifest for ${manifest.repositoryKey}.`,
      )
    }
    releaseTags.push(fallbackTag)
    grouped.set(fallbackTag, [])
  }

  const nextReleases = releaseTags.map((releaseTagName) =>
    summarizeManifestForReleaseEntry(
      manifest,
      releaseTagName,
      grouped.get(releaseTagName) ?? [],
    ),
  )
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


export function buildReleaseSyncManifestBlobPrefix(
  repositoryKey: string,
  prefix = 'release-sync',
) {
  const [owner, repo] = repositoryKey.split('/')
  return `${prefix.replace(/\/+$/, '')}/${owner}/${repo}`
}

/** One logical manifest file per software/repository (not per release tag). */
export function buildReleaseSyncManifestBlobName(
  repositoryKey: string,
  prefix = 'release-sync',
  _releaseTagName?: string | null,
) {
  return `${buildReleaseSyncManifestBlobPrefix(repositoryKey, prefix)}/manifest.json`
}

export function logicalPathToAssetName(logicalPath: string) {
  const normalized = logicalPath.replace(/^\/+/, '').replace(/\/+$/, '')
  const segments = normalized.split('/').filter(Boolean)
  if (segments.length === 0) {
    throw new Error('Logical storage path must not be empty.')
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new Error(`Unsafe path segment "${segment}" in logical storage path "${logicalPath}".`)
    }
    if (segment.includes(ASSET_PATH_SEPARATOR)) {
      throw new Error(
        `Path segment "${segment}" must not contain "${ASSET_PATH_SEPARATOR}" (reserved asset delimiter).`,
      )
    }
  }

  return segments.join(ASSET_PATH_SEPARATOR)
}

export function assetNameToLogicalPath(assetName: string) {
  return assetName.split(ASSET_PATH_SEPARATOR).join('/')
}

function isNotFoundError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false
  }

  const status =
    typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : undefined

  return status === 404
}

function normalizeGitHubMetadataError(error: unknown, operation: string) {
  if (error instanceof MetadataPublicationError) {
    return error
  }

  const message = getErrorMessage(error)
  const status =
    error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : error && typeof error === 'object' && typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : undefined

  if (status === 401 || status === 403) {
    return new Error(
      `GitHub draft-release metadata ${operation} failed [权限不足]：token 需要 contents:write 以读写 draft release assets。原始错误：${message}`,
    )
  }

  return error instanceof Error
    ? error
    : new Error(`GitHub draft-release metadata ${operation} failed: ${message}`)
}

export async function resolveLatestDraftRelease(
  client: Pick<DrafterReleaseGitHubClient, 'listReleases'>,
  options?: { owner?: string; repo?: string },
): Promise<DraftReleaseRef> {
  const releases = await client.listReleases()
  const drafts = releases
    .filter((release) => release.draft === true)
    .sort((left, right) => {
      const byCreated = Date.parse(right.created_at) - Date.parse(left.created_at)
      if (byCreated !== 0) {
        return byCreated
      }
      return right.id - left.id
    })

  const latest = drafts[0]
  if (!latest) {
    const location =
      options?.owner && options?.repo ? `${options.owner}/${options.repo}` : 'the storage repository'
    throw new Error(
      `No draft (drafter) release found in ${location}. Create or keep a draft release for index storage before running release-sync.`,
    )
  }

  return {
    id: latest.id,
    tagName: latest.tag_name,
    createdAt: latest.created_at,
    htmlUrl: latest.html_url,
  }
}

export function createGitHubDrafterReleaseClient(options: {
  token: string
  apiBaseUrl?: string
  owner: string
  repo: string
  fetchImpl?: typeof fetch
}): DrafterReleaseGitHubClient {
  const apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const uploadsBaseUrl = apiBaseUrl.includes('api.github.com')
    ? 'https://uploads.github.com'
    : apiBaseUrl.replace('://api.', '://uploads.')

  async function request(
    url: string,
    init?: RequestInit & { rawBody?: boolean },
  ): Promise<Response> {
    const headers = new Headers(init?.headers)
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${options.token}`)
    }
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/vnd.github+json')
    }
    if (!headers.has('X-GitHub-Api-Version')) {
      headers.set('X-GitHub-Api-Version', '2022-11-28')
    }
    if (!headers.has('User-Agent')) {
      headers.set('User-Agent', 'syncer-action-drafter-release-manifest-store')
    }

    const response = await fetchImpl(url, {
      ...init,
      headers,
    })

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      const error = new Error(
        `GitHub API ${init?.method ?? 'GET'} ${url} failed (${response.status}): ${bodyText || response.statusText}`,
      ) as Error & { status: number; statusCode: number }
      error.status = response.status
      error.statusCode = response.status
      throw error
    }

    return response
  }

  return {
    async listReleases() {
      const releases: Array<{
        id: number
        tag_name: string
        draft: boolean
        created_at: string
        html_url?: string
      }> = []
      let page = 1

      while (page <= 20) {
        const url = `${apiBaseUrl}/repos/${options.owner}/${options.repo}/releases?per_page=100&page=${page}`
        const response = await request(url)
        const batch = (await response.json()) as Array<{
          id: number
          tag_name: string
          draft: boolean
          created_at: string
          html_url?: string
        }>
        releases.push(...batch)
        if (batch.length < 100) {
          break
        }
        page += 1
      }

      return releases
    },

    async listReleaseAssets(releaseId) {
      const assets: ReleaseAssetRef[] = []
      let page = 1

      while (page <= 20) {
        const url = `${apiBaseUrl}/repos/${options.owner}/${options.repo}/releases/${releaseId}/assets?per_page=100&page=${page}`
        const response = await request(url)
        const batch = (await response.json()) as Array<{
          id: number
          name: string
          size: number
          url: string
          browser_download_url?: string
          updated_at?: string
        }>
        assets.push(
          ...batch.map((asset) => ({
            id: asset.id,
            name: asset.name,
            size: asset.size,
            url: asset.url,
            browserDownloadUrl: asset.browser_download_url,
            updatedAt: asset.updated_at,
          })),
        )
        if (batch.length < 100) {
          break
        }
        page += 1
      }

      return assets
    },

    async downloadAsset(asset) {
      const response = await request(asset.url, {
        headers: {
          Accept: 'application/octet-stream',
        },
      })
      return await response.text()
    },

    async deleteAsset(assetId) {
      await request(`${apiBaseUrl}/repos/${options.owner}/${options.repo}/releases/assets/${assetId}`, {
        method: 'DELETE',
      })
    },

    async uploadReleaseAsset(releaseId, assetName, body) {
      const payload =
        typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body)
      const url = `${uploadsBaseUrl}/repos/${options.owner}/${options.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`
      const response = await request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/vnd.github+json',
        },
        body: payload,
      })
      const asset = (await response.json()) as {
        id: number
        name: string
        size: number
        url: string
        browser_download_url?: string
        updated_at?: string
      }
      return {
        id: asset.id,
        name: asset.name,
        size: asset.size,
        url: asset.url,
        browserDownloadUrl: asset.browser_download_url,
        updatedAt: asset.updated_at,
      }
    },
  }
}

export function createDrafterReleaseManifestStore(options: {
  owner: string
  repo: string
  prefix?: string
  token?: string
  apiBaseUrl?: string
  now?: () => Date
  client?: DrafterReleaseGitHubClient
}): ReleaseSyncMetadataStore {
  const now = options.now ?? (() => new Date())
  const prefix = options.prefix ?? 'release-sync'
  const client =
    options.client ??
    createGitHubDrafterReleaseClient({
      token: options.token ?? '',
      apiBaseUrl: options.apiBaseUrl,
      owner: options.owner,
      repo: options.repo,
    })

  if (!options.client && !options.token?.trim()) {
    throw new Error('GITHUB_TOKEN is required to read/write drafter release metadata assets.')
  }

  async function resolveStorage() {
    return resolveLatestDraftRelease(client, { owner: options.owner, repo: options.repo })
  }

  async function findAssetByLogicalPath(releaseId: number, logicalPath: string) {
    const assetName = logicalPathToAssetName(logicalPath)
    const assets = await client.listReleaseAssets(releaseId)
    return assets.find((asset) => asset.name === assetName)
  }

  async function downloadJsonByLogicalPath(releaseId: number, logicalPath: string) {
    const asset = await findAssetByLogicalPath(releaseId, logicalPath)
    if (!asset) {
      return { contents: null as string | null, etag: undefined as string | undefined, assetName: logicalPathToAssetName(logicalPath) }
    }

    const contents = await client.downloadAsset(asset)
    return {
      contents,
      etag: asset.updatedAt ?? String(asset.id),
      assetName: asset.name,
    }
  }

  async function replaceAsset(releaseId: number, logicalPath: string, body: string) {
    const assetName = logicalPathToAssetName(logicalPath)
    const existing = await findAssetByLogicalPath(releaseId, logicalPath)
    if (existing) {
      await client.deleteAsset(existing.id)
    }
    return client.uploadReleaseAsset(releaseId, assetName, body)
  }

  async function loadManifestIndexInternal() {
    const blobPath = buildReleaseSyncManifestIndexBlobName(prefix)
    const draft = await resolveStorage()

    try {
      const { contents, etag } = await downloadJsonByLogicalPath(draft.id, blobPath)
      if (!contents?.trim()) {
        return createEmptyReleaseSyncManifestIndex(now(), prefix)
      }

      return normalizeManifestIndex(
        JSON.parse(contents) as Partial<ReleaseSyncManifestIndex>,
        now().toISOString(),
        blobPath,
        etag,
      )
    } catch (error) {
      if (isNotFoundError(error)) {
        return createEmptyReleaseSyncManifestIndex(now(), prefix)
      }
      throw normalizeGitHubMetadataError(error, 'root manifest index download')
    }
  }


  return {
    async loadManifest(repositoryKey, releaseTagName) {
      const draft = await resolveStorage()
      const logicalPath = buildReleaseSyncManifestBlobName(repositoryKey, prefix)

      try {
        const { contents, etag } = await downloadJsonByLogicalPath(draft.id, logicalPath)
        if (!contents?.trim()) {
          return createEmptyManifest(
            repositoryKey,
            now(),
            releaseTagName ?? null,
            logicalPath,
          )
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
          etag,
          releaseTagName?.trim() || parsed.releaseTagName || null,
          logicalPath,
        )
      } catch (error) {
        if (isNotFoundError(error)) {
          return createEmptyManifest(
            repositoryKey,
            now(),
            releaseTagName ?? null,
            logicalPath,
          )
        }
        throw normalizeGitHubMetadataError(
          error,
          `manifest download for ${repositoryKey}`,
        )
      }
    },

    async loadManifestIndex() {
      return loadManifestIndexInternal()
    },

    async saveManifest(manifest) {
      const releaseTagName = manifest.releaseTagName?.trim()
      if (!releaseTagName) {
        throw new Error(
          `A releaseTagName is required to save the manifest for ${manifest.repositoryKey}.`,
        )
      }

      const blobPath = buildReleaseSyncManifestBlobName(
        manifest.repositoryKey,
        prefix,
        releaseTagName,
      )
      const nextManifest: ReleaseSyncManifest = {
        ...manifest,
        releaseTagName,
        version: 1,
        updatedAt: now().toISOString(),
        blobPath,
      }
      const payload = JSON.stringify(nextManifest, null, 2)
      let uploaded: ReleaseAssetRef

      try {
        const draft = await resolveStorage()
        uploaded = await replaceAsset(draft.id, blobPath, payload)
      } catch (error) {
        throw normalizeGitHubMetadataError(
          error,
          `manifest upload for ${manifest.repositoryKey}`,
        )
      }

      const persistedManifest: ReleaseSyncManifest = {
        ...nextManifest,
        etag: uploaded.updatedAt ?? String(uploaded.id),
      }
      const indexBlobPath = buildReleaseSyncManifestIndexBlobName(prefix)

      try {
        const draft = await resolveStorage()
        const currentIndex = await loadManifestIndexInternal()
        const refreshedIndex = upsertManifestIndexRepository(
          currentIndex,
          persistedManifest,
          now().toISOString(),
          indexBlobPath,
        )
        await replaceAsset(draft.id, indexBlobPath, JSON.stringify(refreshedIndex, null, 2))
      } catch (error) {
        const normalizedError = normalizeGitHubMetadataError(
          error,
          `root manifest index refresh for ${manifest.repositoryKey}`,
        )

        throw new MetadataPublicationError(
          {
            repositoryKey: manifest.repositoryKey,
            message: getErrorMessage(normalizedError),
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

export const createReleaseSyncMetadataStore = createDrafterReleaseManifestStore
