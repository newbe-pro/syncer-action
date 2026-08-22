import { AwsClient } from 'aws4fetch'
import type {
  MetadataPublicationFailure, ReleaseSyncManifest, ReleaseSyncManifestIndex,
  ReleaseSyncManifestIndexRepositoryEntry, ReleaseSyncRecord,
} from '../release-sync-contracts'

export interface ReleaseSyncMetadataStore {
  loadManifest(repositoryKey: string, releaseTagName?: string): Promise<ReleaseSyncManifest>
  loadManifestIndex(): Promise<ReleaseSyncManifestIndex>
  saveManifest(manifest: ReleaseSyncManifest): Promise<ReleaseSyncManifest>
}
export class MetadataPublicationError extends Error {
  constructor(readonly details: MetadataPublicationFailure, options?: { cause?: unknown }) {
    super(details.message, options); this.name = 'MetadataPublicationError'
  }
}
export const DEFAULT_R2_ENDPOINT = 'https://3128b6a4e4d5adb3f296e43f0963e60f.r2.cloudflarestorage.com/syncer'
export const DEFAULT_R2_PUBLIC_ENDPOINT = 'https://syncer.hagicode.com'
export function buildReleaseSyncManifestIndexBlobName(prefix = 'release-sync') { return `${prefix.replace(/\/+$/, '')}/index.json` }
export function buildReleaseSyncManifestBlobName(repositoryKey: string, prefix = 'release-sync', _tag?: string | null) {
  const [owner, repo] = repositoryKey.split('/')
  if (!owner || !repo || owner === '.' || repo === '.' || owner === '..' || repo === '..') throw new Error(`Unsafe repository key "${repositoryKey}".`)
  return `${prefix.replace(/\/+$/, '')}/${owner}/${repo}/manifest.json`
}
const message = (e: unknown) => e instanceof Error ? e.message : String(e)
const time = (a: string | null | undefined, b: string | null | undefined) => {
  if (!a) return b ? -1 : 0; if (!b) return 1
  const n = Date.parse(a) - Date.parse(b); return Number.isNaN(n) ? a.localeCompare(b) : n
}
const emptyManifest = (key: string, path: string, now: Date, tag?: string | null) =>
  ({ repositoryKey: key, releaseTagName: tag ?? null, version: 1, updatedAt: now.toISOString(), records: [], blobPath: path }) satisfies ReleaseSyncManifest
const emptyIndex = (path: string, now: Date) =>
  ({ version: 1, updatedAt: now.toISOString(), repositories: [], blobPath: path }) satisfies ReleaseSyncManifestIndex
function refresh(index: ReleaseSyncManifestIndex, manifest: ReleaseSyncManifest, path: string, updatedAt: string) {
  const groups = new Map<string, ReleaseSyncRecord[]>()
  for (const r of manifest.records) groups.set(r.releaseTagName, [...(groups.get(r.releaseTagName) ?? []), r])
  const tag = manifest.releaseTagName?.trim()
  if (!groups.size && tag) groups.set(tag, [])
  if (!groups.size) throw new Error(`A releaseTagName is required to summarize ${manifest.repositoryKey}.`)
  const releases = [...groups.entries()].map(([releaseTagName, records]) => {
    const latest = records.reduce<ReleaseSyncRecord | undefined>((a, r) => !a || time(r.lastAttemptedAt, a.lastAttemptedAt) > 0 ? r : a, undefined)
    const successful = records.reduce<string | null>((a, r) => time(a, r.lastSyncedAt) >= 0 ? a : r.lastSyncedAt, null)
    const [owner = manifest.repositoryKey, repo = manifest.repositoryKey] = manifest.repositoryKey.split('/', 2)
    return { repositoryKey: manifest.repositoryKey, owner, repo, displayName: manifest.repositoryKey, releaseTagName, manifestPath: path, recordCount: records.length, updatedAt: manifest.updatedAt, lastAttemptedAt: latest?.lastAttemptedAt ?? null, lastSuccessfulAt: successful, status: latest?.status === 'synced' ? 'synced' : latest ? 'failed' : 'awaiting_evidence' } as const
  }).sort((a, b) => a.releaseTagName.localeCompare(b.releaseTagName))
  const latest = releases.reduce((a, b) => time(a.lastAttemptedAt, b.lastAttemptedAt) >= 0 ? a : b)
  const [owner = manifest.repositoryKey, repo = manifest.repositoryKey] = manifest.repositoryKey.split('/', 2)
  const entry: ReleaseSyncManifestIndexRepositoryEntry = { ...latest, owner, repo, displayName: manifest.repositoryKey, lastSuccessfulAt: releases.reduce<string | null>((a, r) => time(a, r.lastSuccessfulAt) >= 0 ? a : r.lastSuccessfulAt, null), releases }
  return { version: 1, updatedAt, repositories: [...index.repositories.filter(r => r.repositoryKey !== manifest.repositoryKey), entry].sort((a, b) => a.repositoryKey.localeCompare(b.repositoryKey)), blobPath: path }
}
export function createR2ManifestStore(options: { endpoint?: string; publicEndpoint?: string; prefix?: string; accessKeyId: string; secretAccessKey: string; fetchImpl?: typeof fetch; now?: () => Date }): ReleaseSyncMetadataStore {
  if (!options.accessKeyId.trim() || !options.secretAccessKey.trim()) throw new Error('R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required.')
  const endpoint = (options.endpoint ?? DEFAULT_R2_ENDPOINT).replace(/\/+$/, '')
  const publicEndpoint = (options.publicEndpoint ?? DEFAULT_R2_PUBLIC_ENDPOINT).replace(/\/+$/, '')
  const prefix = (options.prefix ?? 'release-sync').replace(/^\/+|\/+$/g, '')
  const fetchImpl = options.fetchImpl ?? fetch, now = options.now ?? (() => new Date())
  const r2Client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    service: 's3',
    region: 'auto',
  })
  async function request(path: string, method: 'GET' | 'PUT', body = '') {
    const url = new URL(`${method === 'GET' ? publicEndpoint : endpoint}/${path.replace(/^\/+/, '')}`)
    let response: Response
    try {
      response = await (method === 'PUT'
        ? fetchImpl(await r2Client.sign(url, {
            method,
            body,
            headers: { 'Content-Type': 'application/json' },
          }))
        : fetchImpl(url, { method }))
    }
    catch (e) { throw new Error(`R2 ${method} ${path} network failure: ${message(e)}`, { cause: e }) }
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`R2 ${method} ${path} failed (${response.status} ${response.statusText}): ${(await response.text().catch(() => '')).slice(0, 500)}`)
    return response
  }
  async function read<T>(path: string, fallback: T) {
    const response = await request(path, 'GET'); if (!response) return fallback
    try { return JSON.parse(await response.text()) as T } catch (e) { throw new Error(`R2 GET ${path} returned invalid JSON: ${message(e)}`, { cause: e }) }
  }
  return {
    async loadManifest(key, tag) { const path = buildReleaseSyncManifestBlobName(key, prefix), value = await read<Partial<ReleaseSyncManifest> | null>(path, null); return value ? { ...value, repositoryKey: key, records: value.records ?? [], version: 1, releaseTagName: tag ?? value.releaseTagName ?? null, blobPath: path } as ReleaseSyncManifest : emptyManifest(key, path, now(), tag) },
    async loadManifestIndex() { const path = buildReleaseSyncManifestIndexBlobName(prefix), value = await read<Partial<ReleaseSyncManifestIndex> | null>(path, null); return value ? { ...value, version: 1, repositories: value.repositories ?? [], blobPath: path } as ReleaseSyncManifestIndex : emptyIndex(path, now()) },
    async saveManifest(manifest) {
      const tag = manifest.releaseTagName?.trim(); if (!tag) throw new Error(`A releaseTagName is required to save the manifest for ${manifest.repositoryKey}.`)
      const manifestPath = buildReleaseSyncManifestBlobName(manifest.repositoryKey, prefix, tag), next = { ...manifest, releaseTagName: tag, version: 1, updatedAt: now().toISOString(), blobPath: manifestPath }
      await request(manifestPath, 'PUT', JSON.stringify(next, null, 2)); const indexPath = buildReleaseSyncManifestIndexBlobName(prefix)
      try { await request(indexPath, 'PUT', JSON.stringify(refresh(await this.loadManifestIndex(), next, manifestPath, now().toISOString()), null, 2)) }
      catch (e) { throw new MetadataPublicationError({ repositoryKey: manifest.repositoryKey, message: message(e), manifestPath, rootIndexPath: indexPath, manifestPersisted: true, occurredAt: now().toISOString() }, { cause: e }) }
      return next
    },
  }
}
export const createReleaseSyncMetadataStore = createR2ManifestStore
