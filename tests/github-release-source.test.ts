import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createGitHubReleaseSource } from '../src/github-release-source'

const repository = {
  key: 'openai/codex',
  owner: 'openai',
  repo: 'codex',
}

function createJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

describe('createGitHubReleaseSource', () => {
  it('returns only assets from the latest published release while preserving latest metadata', async () => {
    const latestRelease = {
      id: 9999,
      tag_name: 'v2.0.0',
      name: 'v2.0.0',
      published_at: '2026-04-10T09:00:00.000Z',
      assets: [
        {
          id: 2000,
          name: 'codex-latest.zip',
          size: 2048,
          browser_download_url: 'https://example.com/releases/v2.0.0/codex-latest.zip',
          updated_at: '2026-04-10T09:05:00.000Z',
        },
        {
          id: 2001,
          name: 'codex-latest.tar.gz',
          size: 4096,
          browser_download_url: 'https://example.com/releases/v2.0.0/codex-latest.tar.gz',
          updated_at: '2026-04-10T09:10:00.000Z',
        },
      ],
    }
    const previousRelease = {
      id: 100,
      tag_name: 'v1.9.0',
      name: 'v1.9.0',
      published_at: '2026-04-01T09:00:00.000Z',
      assets: [
        {
          id: 1000,
          name: 'codex-previous.zip',
          size: 1024,
          browser_download_url: 'https://example.com/releases/v1.9.0/codex-previous.zip',
          updated_at: '2026-04-01T09:05:00.000Z',
        },
      ],
    }
    const draftRelease = {
      id: 10001,
      tag_name: 'v2.1.0-rc1',
      name: 'v2.1.0-rc1',
      published_at: null,
      assets: [
        {
          id: 3000,
          name: 'codex-draft.zip',
          size: 100,
          browser_download_url: 'https://example.com/releases/v2.1.0-rc1/codex-draft.zip',
          updated_at: '2026-04-11T09:05:00.000Z',
        },
      ],
    }

    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      if (url.endsWith('/releases?per_page=100&page=1')) {
        return createJsonResponse([draftRelease, latestRelease, previousRelease])
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    const source = createGitHubReleaseSource({
      repositories: [repository],
      fetch,
    })

    const assets = await source.listReleaseAssets()

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(assets).toHaveLength(2)
    expect(assets.every((asset) => asset.latestReleaseId === latestRelease.id)).toBe(true)
    expect(assets.every((asset) => asset.latestReleaseTagName === latestRelease.tag_name)).toBe(
      true,
    )
    expect(assets.every((asset) => asset.latestReleasePublishedAt === latestRelease.published_at)).toBe(
      true,
    )
    expect(assets.find((asset) => asset.assetName === 'codex-latest.zip')).toMatchObject({
      releaseId: latestRelease.id,
      releaseTagName: latestRelease.tag_name,
      latestReleaseId: latestRelease.id,
      latestReleaseTagName: latestRelease.tag_name,
    })
    expect(assets.find((asset) => asset.assetName === 'codex-previous.zip')).toBeUndefined()
  })

  it('stops paging once the latest published release can be resolved from the current snapshot', async () => {
    const pageOneReleases = Array.from({ length: 100 }, (_, index) => ({
      id: 10_000 - index,
      tag_name: `v${100 - index}.0.0`,
      name: `v${100 - index}.0.0`,
      published_at:
        index === 0
          ? '2026-05-01T09:00:00.000Z'
          : '2026-04-01T09:00:00.000Z',
      assets: index === 0
        ? [
            {
              id: 4000,
              name: 'codex-page-one.zip',
              size: 4096,
              browser_download_url: 'https://example.com/releases/v100.0.0/codex-page-one.zip',
              updated_at: '2026-04-12T09:05:00.000Z',
            },
          ]
        : [],
    }))
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      if (url.endsWith('/releases?per_page=100&page=1')) {
        return createJsonResponse(pageOneReleases)
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    const source = createGitHubReleaseSource({
      repositories: [repository],
      fetch,
    })

    const assets = await source.listReleaseAssets()

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(assets).toEqual([
      expect.objectContaining({
        releaseTagName: 'v100.0.0',
        latestReleaseTagName: 'v100.0.0',
        assetName: 'codex-page-one.zip',
      }),
    ])
  })

  it('continues paging until it finds a published release and still returns only that latest release assets', async () => {
    const draftOnlyPage = Array.from({ length: 100 }, (_, index) => ({
      id: 20_000 - index,
      tag_name: `v200.0.0-rc${index + 1}`,
      name: `v200.0.0-rc${index + 1}`,
      published_at: null,
      assets: [
        {
          id: 5000 + index,
          name: `codex-draft-${index + 1}.zip`,
          size: 1024 + index,
          browser_download_url: `https://example.com/releases/v200.0.0-rc${index + 1}/codex-draft-${index + 1}.zip`,
          updated_at: '2026-04-12T09:05:00.000Z',
        },
      ],
    }))
    const latestPublishedRelease = {
      id: 4000,
      tag_name: 'v199.0.0',
      name: 'v199.0.0',
      published_at: '2026-04-11T09:00:00.000Z',
      assets: [
        {
          id: 6000,
          name: 'codex-published.zip',
          size: 8192,
          browser_download_url: 'https://example.com/releases/v199.0.0/codex-published.zip',
          updated_at: '2026-04-11T09:05:00.000Z',
        },
      ],
    }
    const olderPublishedRelease = {
      id: 3999,
      tag_name: 'v198.0.0',
      name: 'v198.0.0',
      published_at: '2026-04-01T09:00:00.000Z',
      assets: [
        {
          id: 6001,
          name: 'codex-older.zip',
          size: 4096,
          browser_download_url: 'https://example.com/releases/v198.0.0/codex-older.zip',
          updated_at: '2026-04-01T09:05:00.000Z',
        },
      ],
    }

    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      if (url.endsWith('/releases?per_page=100&page=1')) {
        return createJsonResponse(draftOnlyPage)
      }

      if (url.endsWith('/releases?per_page=100&page=2')) {
        return createJsonResponse([latestPublishedRelease, olderPublishedRelease])
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    const source = createGitHubReleaseSource({
      repositories: [repository],
      fetch,
    })

    const assets = await source.listReleaseAssets()

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(assets).toEqual([
      expect.objectContaining({
        releaseId: latestPublishedRelease.id,
        releaseTagName: latestPublishedRelease.tag_name,
        latestReleaseId: latestPublishedRelease.id,
        latestReleaseTagName: latestPublishedRelease.tag_name,
        latestReleasePublishedAt: latestPublishedRelease.published_at,
        assetName: 'codex-published.zip',
      }),
    ])
  })

  it('downloads assets into the configured project temp directory and creates it on demand', async () => {
    const workspaceDirectory = await mkdtemp(path.join(tmpdir(), 'syncer-source-'))
    const releaseTempDirectory = path.join(
      workspaceDirectory,
      '.runtime',
      'release-downloads',
    )

    try {
      const source = createGitHubReleaseSource({
        repositories: [repository],
        temporaryDirectory: releaseTempDirectory,
        fetch: vi.fn(async () => new Response('release-bytes', { status: 200 })),
      })

      const downloaded = await source.downloadAsset({
        repositoryKey: repository.key,
        releaseId: 1,
        releaseTagName: 'v1.0.0',
        releaseName: 'v1.0.0',
        releasePublishedAt: '2026-04-10T09:00:00.000Z',
        latestReleaseId: 1,
        latestReleaseTagName: 'v1.0.0',
        latestReleasePublishedAt: '2026-04-10T09:00:00.000Z',
        assetId: 101,
        assetName: 'codex-linux-x64.zip',
        assetSize: 13,
        browserDownloadUrl: 'https://example.com/releases/v1.0.0/codex-linux-x64.zip',
        assetUpdatedAt: '2026-04-10T09:05:00.000Z',
      })

      expect(downloaded.filePath.startsWith(`${releaseTempDirectory}${path.sep}`)).toBe(true)
      expect(downloaded.byteSize).toBe(13)

      await downloaded.cleanup()
    } finally {
      await rm(workspaceDirectory, { recursive: true, force: true })
    }
  })
})
