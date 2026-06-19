import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { type ReadableStream as NodeReadableStream } from 'node:stream/web'
import { z } from 'zod'
import { type GitHubTargetRepository } from './config'
import {
  type DownloadedReleaseAsset,
  type GitHubReleaseAsset,
} from './release-sync-contracts'

const githubReleaseSchema = z.object({
  id: z.number(),
  tag_name: z.string(),
  name: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  assets: z
    .array(
      z.object({
        id: z.number(),
        name: z.string(),
        size: z.number().nonnegative(),
        browser_download_url: z.string().url(),
        updated_at: z.string(),
      }),
    )
    .default([]),
})

type GitHubReleaseResponse = z.infer<typeof githubReleaseSchema>

export interface GitHubReleaseSource {
  readonly targets: GitHubTargetRepository[]
  listReleaseAssets(options?: { signal?: AbortSignal }): Promise<GitHubReleaseAsset[]>
  downloadAsset(
    asset: GitHubReleaseAsset,
    options?: { signal?: AbortSignal },
  ): Promise<DownloadedReleaseAsset>
}

function sanitizeFileName(assetName: string) {
  return assetName.replace(/[^A-Za-z0-9._-]/g, '_')
}

function resolveFileSystemErrorCode(error: unknown) {
  const systemError = error as NodeJS.ErrnoException

  if (typeof systemError?.code === 'string' && systemError.code.length > 0) {
    return systemError.code
  }

  if (systemError?.errno === -122 || systemError?.errno === 122) {
    return 'EDQUOT'
  }

  return null
}

function createDownloadPersistenceError(
  asset: GitHubReleaseAsset,
  filePath: string,
  error: unknown,
) {
  const code = resolveFileSystemErrorCode(error)
  const originalMessage =
    error instanceof Error ? error.message : 'Unknown filesystem write error.'

  switch (code) {
    case 'EDQUOT':
      return new Error(
        `Failed to write downloaded asset for ${asset.repositoryKey}:${asset.assetName} to ${filePath}: temporary directory quota exceeded (EDQUOT). Original error: ${originalMessage}`,
      )
    case 'ENOSPC':
      return new Error(
        `Failed to write downloaded asset for ${asset.repositoryKey}:${asset.assetName} to ${filePath}: no space left on the temporary filesystem (ENOSPC). Original error: ${originalMessage}`,
      )
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return new Error(
        `Failed to write downloaded asset for ${asset.repositoryKey}:${asset.assetName} to ${filePath}: the temporary directory is not writable (${code}). Original error: ${originalMessage}`,
      )
    default:
      return error
  }
}

export function createGitHubReleaseSource(options: {
  repositories: GitHubTargetRepository[]
  token?: string
  apiBaseUrl?: string
  temporaryDirectory?: string
  fetch?: typeof fetch
}): GitHubReleaseSource {
  const fetcher = options.fetch ?? fetch
  const apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  const temporaryDirectory = options.temporaryDirectory ?? tmpdir()

  function createHeaders(download = false) {
    const headers = new Headers({
      Accept: download ? 'application/octet-stream' : 'application/vnd.github+json',
      'User-Agent': 'syncer-action-release-sync',
      'X-GitHub-Api-Version': '2022-11-28',
    })

    if (options.token) {
      headers.set('Authorization', `Bearer ${options.token}`)
    }

    return headers
  }

  async function requestReleases(
    repository: GitHubTargetRepository,
    page: number,
    signal?: AbortSignal,
  ) {
    const response = await fetcher(
      `${apiBaseUrl}/repos/${repository.owner}/${repository.repo}/releases?per_page=100&page=${page}`,
      {
        headers: createHeaders(),
        signal,
      },
    )

    if (!response.ok) {
      throw new Error(
        `GitHub release lookup failed for ${repository.key}: ${response.status} ${response.statusText}`,
      )
    }

    return z.array(githubReleaseSchema).parse(await response.json())
  }

  function resolveLatestPublishedRelease(releases: GitHubReleaseResponse[]) {
    return releases.reduce<GitHubReleaseResponse | undefined>((currentLatest, candidate) => {
      if (!candidate.published_at) {
        return currentLatest
      }

      if (!currentLatest) {
        return candidate
      }

      const currentLatestPublishedAt = Date.parse(currentLatest.published_at ?? '')
      const candidatePublishedAt = Date.parse(candidate.published_at ?? '')

      if (candidatePublishedAt > currentLatestPublishedAt) {
        return candidate
      }

      if (candidatePublishedAt === currentLatestPublishedAt && candidate.id > currentLatest.id) {
        return candidate
      }

      return currentLatest
    }, undefined)
  }

  function normalizeReleaseAssets(
    repository: GitHubTargetRepository,
    latestRelease: GitHubReleaseResponse,
  ) {
    return latestRelease.assets.map(
      (asset): GitHubReleaseAsset => ({
        repositoryKey: repository.key,
        releaseId: latestRelease.id,
        releaseTagName: latestRelease.tag_name,
        releaseName: latestRelease.name ?? null,
        releasePublishedAt: latestRelease.published_at ?? null,
        latestReleaseId: latestRelease.id,
        latestReleaseTagName: latestRelease.tag_name,
        latestReleasePublishedAt: latestRelease.published_at ?? null,
        assetId: asset.id,
        assetName: asset.name,
        assetSize: asset.size,
        browserDownloadUrl: asset.browser_download_url,
        assetUpdatedAt: asset.updated_at,
      }),
    )
  }

  return {
    targets: [...options.repositories],
    async listReleaseAssets({ signal } = {}) {
      const assets: GitHubReleaseAsset[] = []

      for (const repository of options.repositories) {
        for (let page = 1; ; page += 1) {
          const pagedReleases = await requestReleases(repository, page, signal)
          const latestRelease = resolveLatestPublishedRelease(pagedReleases)

          if (latestRelease) {
            assets.push(...normalizeReleaseAssets(repository, latestRelease))
            break
          }

          if (pagedReleases.length < 100) {
            break
          }
        }
      }

      return assets
    },
    async downloadAsset(asset, { signal } = {}) {
      const response = await fetcher(asset.browserDownloadUrl, {
        headers: createHeaders(true),
        redirect: 'follow',
        signal,
      })

      if (!response.ok) {
        throw new Error(
          `GitHub asset download failed for ${asset.repositoryKey}:${asset.assetName}: ${response.status} ${response.statusText}`,
        )
      }

      if (!response.body) {
        throw new Error(
          `GitHub asset download returned an empty body for ${asset.repositoryKey}:${asset.assetName}.`,
        )
      }

      await mkdir(temporaryDirectory, { recursive: true })
      const directory = await mkdtemp(path.join(temporaryDirectory, 'syncer-release-'))
      const filePath = path.join(directory, sanitizeFileName(asset.assetName))

      try {
        await pipeline(
          Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
          createWriteStream(filePath),
          { signal },
        )
        const metadata = await stat(filePath)

        return {
          asset,
          filePath,
          byteSize: metadata.size,
          cleanup: async () => {
            await rm(directory, { recursive: true, force: true })
          },
        }
      } catch (error) {
        await rm(directory, { recursive: true, force: true })
        throw createDownloadPersistenceError(asset, filePath, error)
      }
    },
  }
}
