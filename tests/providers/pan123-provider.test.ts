import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPan123NetdiskProvider } from '../../src/providers/pan123-provider'

interface Pan123FailureLike {
  diagnostics?: {
    response?: {
      headers?: Record<string, string>
      bodyExcerpt?: string
    }
    provider?: {
      code?: number
    }
    retry?: {
      attempts?: number
      maxAttempts?: number
      intervalMs?: number
      recentLogs?: Array<{
        attempt?: number
        httpStatus?: number | null
        message?: string
        uploadedBytes?: number | null
        totalBytes?: number | null
      }>
    }
  }
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

async function createTempDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'syncer-pan123-provider-'))
  temporaryDirectories.push(directory)
  return directory
}

async function createUploadRequest(assetName = 'ollama-linux-amd64.tgz') {
  const directory = await createTempDirectory()
  const filePath = path.join(directory, assetName)
  await writeFile(filePath, 'hello ollama')

  return {
    asset: {
      repositoryKey: 'ollama/ollama',
      releaseId: 1,
      releaseTagName: 'v0.6.0',
      releaseName: 'v0.6.0',
      releasePublishedAt: '2026-04-09T10:00:00.000Z',
      latestReleaseId: 1,
      latestReleaseTagName: 'v0.6.0',
      latestReleasePublishedAt: '2026-04-09T10:00:00.000Z',
      assetId: 2,
      assetName,
      assetSize: 12,
      browserDownloadUrl: `https://example.com/${assetName}`,
      assetUpdatedAt: '2026-04-09T10:05:00.000Z',
    },
    file: {
      filePath,
      byteSize: 12,
      sha256: 'sha-256',
      md5: 'md5-hash',
    },
    destination: {
      repositoryKey: 'ollama/ollama',
      targetDirectory: '/syncer/ollama',
    },
  }
}

function createJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

function getSearchParam(url: string, key: string) {
  return new URL(url).searchParams.get(key)
}

async function captureCreateFileRequest(assetName: string) {
  const request = await createUploadRequest(assetName)
  const directory = await createTempDirectory()
  let createFileRequest:
    | {
        url: string
        body: {
          parentFileID?: string | number
          filename?: string
          etag?: string
          size?: number
          type?: number
        }
      }
    | undefined

  const provider = createPan123NetdiskProvider({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    tokenCachePath: path.join(directory, 'token-cache.json'),
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()

      if (url.endsWith('/api/v1/access_token')) {
        return createJsonResponse({
          code: 0,
          message: 'ok',
          data: {
            accessToken: 'token-1',
            expiredAt: '2026-04-10T01:00:00.000Z',
          },
        })
      }

      if (url.includes('/api/v2/file/list')) {
        const parentFileId = getSearchParam(url, 'parentFileId')

        return createJsonResponse({
          code: 0,
          message: 'ok',
          data: {
            lastFileId: '-1',
            fileList:
              parentFileId === '0'
                ? []
                : [
                    {
                      fileId: 'target-dir',
                      filename: 'ollama',
                      type: 1,
                    },
                  ],
          },
        })
      }

      if (url.endsWith('/upload/v1/file/mkdir')) {
        return createJsonResponse({
          code: 0,
          message: 'ok',
          data: {
            list: [
              {
                filename: 'ollama',
                dirID: 'target-dir',
              },
            ],
          },
        })
      }

      if (url.endsWith('/upload/v1/file/create')) {
        createFileRequest = {
          url,
          body: JSON.parse(String(init?.body ?? '{}')) as {
            parentFileID?: string | number
            filename?: string
            etag?: string
            size?: number
            type?: number
          },
        }
        return createJsonResponse({
          code: 0,
          message: 'ok',
          data: {
            reuse: true,
            fileID: 'remote-file-1',
          },
        })
      }

      if (url.endsWith('/api/v1/share/create')) {
        return createJsonResponse({
          code: 0,
          message: 'ok',
          data: {
            shareID: 87187530,
            shareKey: 'PvitVv-nPeLH',
          },
        })
      }

      throw new Error(`Unexpected request: ${url}`)
    },
  })

  await provider.uploadAsset({
    ...request,
    destination: {
      repositoryKey: request.destination.repositoryKey,
      targetDirectory: '/ollama',
    },
  })

  return createFileRequest
}

describe('createPan123NetdiskProvider', () => {
  it.each(['codex-linux-x64.zip', 'ollama-linux-amd64.tgz', 'cover.png'])(
    'uses the file upload API without a type field for %s',
    async (assetName) => {
      await expect(captureCreateFileRequest(assetName)).resolves.toMatchObject({
        url: expect.stringContaining('/upload/v1/file/create'),
        body: {
          parentFileID: 'target-dir',
          filename: assetName,
          etag: 'md5-hash',
          size: 12,
        },
      })

      const request = await captureCreateFileRequest(assetName)
      expect(request?.body.type).toBeUndefined()
    },
  )

  it.each(['codex-linux-x64.zip', 'ollama-linux-amd64.tgz', 'cover.png'])(
    'creates a permanent share link for %s after upload',
    async (assetName) => {
      const request = await createUploadRequest(assetName)
      const directory = await createTempDirectory()
      let createShareRequest:
        | {
            url: string
            body: {
              shareName?: string
              shareExpire?: number
              fileIDList?: string
            }
          }
        | undefined

      const provider = createPan123NetdiskProvider({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tokenCachePath: path.join(directory, 'token-cache.json'),
        fetch: async (input, init) => {
          const url = typeof input === 'string' ? input : input.toString()

          if (url.endsWith('/api/v1/access_token')) {
            return createJsonResponse({
              code: 0,
              message: 'ok',
              data: {
                accessToken: 'token-1',
                expiredAt: '2026-04-10T01:00:00.000Z',
              },
            })
          }

          if (url.includes('/api/v2/file/list')) {
            return createJsonResponse({
              code: 0,
              message: 'ok',
              data: {
                lastFileId: '-1',
                fileList: [
                  {
                    fileId: 'target-dir',
                    filename: 'ollama',
                    type: 1,
                  },
                ],
              },
            })
          }

          if (url.endsWith('/upload/v1/file/create')) {
            return createJsonResponse({
              code: 0,
              message: 'ok',
              data: {
                reuse: true,
                fileID: 'remote-file-1',
              },
            })
          }

          if (url.endsWith('/api/v1/share/create')) {
            createShareRequest = {
              url,
              body: JSON.parse(String(init?.body ?? '{}')) as {
                shareName?: string
                shareExpire?: number
                fileIDList?: string
              },
            }
            return createJsonResponse({
              code: 0,
              message: 'ok',
              data: {
                shareID: 87187530,
                shareKey: 'PvitVv-nPeLH',
              },
            })
          }

          throw new Error(`Unexpected request: ${url}`)
        },
      })

      await provider.uploadAsset({
        ...request,
        destination: {
          repositoryKey: request.destination.repositoryKey,
          targetDirectory: '/ollama',
        },
      })

      expect(createShareRequest).toMatchObject({
        url: expect.stringContaining('/api/v1/share/create'),
        body: {
          shareName: assetName,
          shareExpire: 0,
          fileIDList: 'remote-file-1',
        },
      })
    },
  )

  it('resolves versioned target directories into a release-tag subdirectory', async () => {
    const request = await createUploadRequest()
    const directory = await createTempDirectory()
    const mkdirNames: string[] = []
    let createFileRequest:
      | {
          body: {
            parentFileID?: string | number
          }
        }
      | undefined

    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: path.join(directory, 'token-cache.json'),
      fetch: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString()

        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'token-1',
              expiredAt: '2026-04-10T01:00:00.000Z',
            },
          })
        }

        if (url.includes('/api/v2/file/list')) {
          const parentFileId = getSearchParam(url, 'parentFileId')
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              lastFileId: '-1',
              fileList:
                parentFileId === '0'
                  ? [
                      {
                        fileId: 'dir-syncer',
                        filename: 'syncer',
                        type: 1,
                      },
                    ]
                  : parentFileId === 'dir-syncer'
                    ? [
                        {
                          fileId: 'dir-ollama',
                          filename: 'ollama',
                          type: 1,
                        },
                      ]
                    : [],
            },
          })
        }

        if (url.endsWith('/upload/v1/file/mkdir')) {
          const body = JSON.parse(String(init?.body ?? '{}')) as { name: string }
          mkdirNames.push(body.name)

          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              list: [
                {
                  filename: body.name,
                  dirID: body.name === 'v0.6.0' ? 'dir-version' : `dir-${body.name}`,
                },
              ],
            },
          })
        }

        if (url.endsWith('/upload/v1/file/create')) {
          createFileRequest = {
            body: JSON.parse(String(init?.body ?? '{}')) as { parentFileID?: string | number },
          }
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              reuse: true,
              fileID: 'remote-file-1',
            },
          })
        }

        if (url.endsWith('/api/v1/share/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              shareID: 87187530,
              shareKey: 'PvitVv-nPeLH',
            },
          })
        }

        throw new Error(`Unexpected request: ${url}`)
      },
    })

    await provider.uploadAsset({
      ...request,
      destination: {
        repositoryKey: request.destination.repositoryKey,
        targetDirectory: '/syncer/ollama/v0.6.0',
      },
    })

    expect(mkdirNames).toEqual(['v0.6.0'])
    expect(createFileRequest?.body.parentFileID).toBe('dir-version')
  })

  it('uploads files and persists a reusable token cache', async () => {
    const request = await createUploadRequest()
    const directory = await createTempDirectory()
    const tokenCachePath = path.join(directory, 'token-cache.json')
    const calls: Array<{ url: string; method: string }> = []

    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath,
      now: () => new Date('2026-04-10T00:00:00.000Z'),
      sleep: async () => {},
      fetch: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = init?.method ?? 'GET'
        calls.push({ url, method })

        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'token-1',
              expiredAt: '2026-04-10T01:00:00.000Z',
            },
          })
        }

        if (url.includes('/api/v2/file/list')) {
          const parentFileId = getSearchParam(url, 'parentFileId')
          if (parentFileId === '0') {
            return createJsonResponse({
              code: 0,
              message: 'ok',
              data: { lastFileId: '-1', fileList: [] },
            })
          }

          if (parentFileId === 'dir-syncer') {
            return createJsonResponse({
              code: 0,
              message: 'ok',
              data: {
                lastFileId: '-1',
                fileList: [
                  {
                    fileId: 'dir-ollama',
                    filename: 'ollama',
                    type: 1,
                  },
                ],
              },
            })
          }

          if (parentFileId === 'dir-ollama') {
            return createJsonResponse({
              code: 0,
              message: 'ok',
              data: {
                lastFileId: '-1',
                fileList: [],
              },
            })
          }
        }

        if (url.endsWith('/upload/v1/file/mkdir')) {
          const body = JSON.parse(String(init?.body ?? '{}')) as { name: string }
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              list: [
                {
                  filename: body.name,
                  dirID: body.name === 'syncer' ? 'dir-syncer' : 'dir-ollama',
                },
              ],
            },
          })
        }

        if (url.endsWith('/upload/v1/file/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              reuse: false,
              preuploadID: 'preupload-1',
              sliceSize: 1024,
            },
          })
        }

        if (url.endsWith('/upload/v1/file/get_upload_url')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              presignedURL: 'https://upload.123pan.example/part-1',
            },
          })
        }

        if (url === 'https://upload.123pan.example/part-1') {
          return new Response(null, { status: 200 })
        }

        if (url.endsWith('/upload/v1/file/upload_complete')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              async: false,
              completed: true,
              fileID: 'remote-file-1',
            },
          })
        }

        if (url.endsWith('/api/v1/share/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              shareID: 87187530,
              shareKey: 'PvitVv-nPeLH',
            },
          })
        }

        throw new Error(`Unexpected request: ${method} ${url}`)
      },
    })

    await expect(provider.uploadAsset(request)).resolves.toEqual({
      providerName: '123pan',
      remoteFileId: 'remote-file-1',
      shareUrl: 'https://www.123pan.com/s/PvitVv-nPeLH',
      uploadedAt: '2026-04-10T00:00:00.000Z',
    })

    const tokenCache = JSON.parse(await readFile(tokenCachePath, 'utf8')) as {
      accessToken: string
    }
    expect(tokenCache.accessToken).toBe('token-1')
    expect(calls.filter((call) => call.url.endsWith('/api/v1/access_token'))).toHaveLength(1)
  })

  it('reuses cached tokens until they expire and then refreshes them', async () => {
    const request = await createUploadRequest()
    const directory = await createTempDirectory()
    const tokenCachePath = path.join(directory, 'token-cache.json')
    let tokenCounter = 0

    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath,
      sleep: async () => {},
      now: () => new Date('2026-04-10T00:00:00.000Z'),
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.toString()

        if (url.endsWith('/api/v1/access_token')) {
          tokenCounter += 1
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: `token-${tokenCounter}`,
              expiredAt:
                tokenCounter === 1
                  ? '2026-04-10T01:00:00.000Z'
                  : '2026-04-10T03:00:00.000Z',
            },
          })
        }

        if (url.includes('/api/v2/file/list')) {
          const parentFileId = getSearchParam(url, 'parentFileId')
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              lastFileId: '-1',
              fileList:
                parentFileId === '0'
                  ? []
                  : [
                      {
                        fileId: 'target-dir',
                        filename: 'ollama',
                        type: 1,
                      },
                    ],
            },
          })
        }

        if (url.endsWith('/upload/v1/file/mkdir')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              list: [
                {
                  filename: 'ollama',
                  dirID: 'target-dir',
                },
              ],
            },
          })
        }

        if (url.endsWith('/upload/v1/file/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              reuse: true,
              fileID: 'reused-file',
            },
          })
        }

        if (url.endsWith('/api/v1/share/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              shareID: 87187531,
              shareKey: 'PvitVv-reused',
            },
          })
        }

        throw new Error(`Unexpected request: ${url}`)
      },
    })

    await provider.uploadAsset({
      ...request,
      destination: { repositoryKey: request.destination.repositoryKey, targetDirectory: '/ollama' },
    })
    await provider.uploadAsset({
      ...request,
      destination: { repositoryKey: request.destination.repositoryKey, targetDirectory: '/ollama' },
    })

    await writeFile(
      tokenCachePath,
      JSON.stringify({
        providerName: '123pan',
        accessToken: 'expired-token',
        expiredAt: '2026-04-09T23:00:00.000Z',
        updatedAt: '2026-04-09T22:00:00.000Z',
      }),
    )

    await provider.uploadAsset({
      ...request,
      destination: { repositoryKey: request.destination.repositoryKey, targetDirectory: '/ollama' },
    })

    expect(tokenCounter).toBe(2)
  })

  it('normalizes authentication failures', async () => {
    const request = await createUploadRequest()
    const directory = await createTempDirectory()

    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: path.join(directory, 'token-cache.json'),
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse(
            { code: 40101, message: 'invalid credentials', data: null },
            401,
          )
        }

        throw new Error(`Unexpected request: ${url}`)
      },
    })

    await expect(provider.uploadAsset(request)).rejects.toThrow(
      /123pan auth failed .* invalid credentials/i,
    )
    await expect(provider.uploadAsset(request)).rejects.toMatchObject({
      diagnostics: {
        detailLevel: 'diagnostic',
        request: {
          path: '/api/v1/access_token',
        },
        response: {
          status: 401,
          bodyExcerpt: expect.stringContaining('invalid credentials'),
        },
        provider: {
          code: 40101,
          message: 'invalid credentials',
        },
      },
    })
  })

  it('normalizes directory failures', async () => {
    const request = await createUploadRequest()
    const directory = await createTempDirectory()

    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: path.join(directory, 'token-cache.json'),
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'token-1',
              expiredAt: '2026-04-10T01:00:00.000Z',
            },
          })
        }
        if (url.includes('/api/v2/file/list')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { lastFileId: '-1', fileList: [] },
          })
        }
        if (url.endsWith('/upload/v1/file/mkdir')) {
          return createJsonResponse({ code: 500, message: 'mkdir failed', data: null })
        }

        throw new Error(`Unexpected request: ${url}`)
      },
    })

    await expect(provider.uploadAsset(request)).rejects.toThrow(/123pan directory failed/i)
    await expect(provider.uploadAsset(request)).rejects.toMatchObject({
      diagnostics: {
        request: {
          path: '/upload/v1/file/mkdir',
        },
        provider: {
          code: 500,
          message: 'mkdir failed',
        },
      },
    })
  })

  it('normalizes upload failures', async () => {
    const request = await createUploadRequest()
    const directory = await createTempDirectory()

    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: path.join(directory, 'token-cache.json'),
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'token-1',
              expiredAt: '2026-04-10T01:00:00.000Z',
            },
          })
        }
        if (url.includes('/api/v2/file/list')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { lastFileId: '-1', fileList: [] },
          })
        }
        if (url.endsWith('/upload/v1/file/mkdir')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { list: [{ filename: 'syncer', dirID: 'target-dir' }] },
          })
        }
        if (url.endsWith('/upload/v1/file/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { reuse: false, preuploadID: 'preupload-1', sliceSize: 1024 },
          })
        }
        if (url.endsWith('/upload/v1/file/get_upload_url')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { presignedURL: 'https://upload.123pan.example/failure' },
          })
        }
        if (url === 'https://upload.123pan.example/failure') {
          return new Response(null, { status: 500, statusText: 'broken upload' })
        }

        throw new Error(`Unexpected request: ${url}`)
      },
    })

    await expect(provider.uploadAsset(request)).rejects.toThrow(/123pan upload failed/i)
    await expect(provider.uploadAsset(request)).rejects.toMatchObject({
      diagnostics: {
        request: {
          method: 'PUT',
          host: 'upload.123pan.example',
          path: '/failure',
        },
        response: {
          status: 500,
          statusText: 'broken upload',
        },
      },
    })
  })

  it('captures recent upload progress for failed PUT uploads', async () => {
    const request = await createUploadRequest()
    const directory = await createTempDirectory()

    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: path.join(directory, 'token-cache.json'),
      fetch: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'token-1',
              expiredAt: '2026-04-10T01:00:00.000Z',
            },
          })
        }
        if (url.includes('/api/v2/file/list')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { lastFileId: '-1', fileList: [] },
          })
        }
        if (url.endsWith('/upload/v1/file/mkdir')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { list: [{ filename: 'syncer', dirID: 'target-dir' }] },
          })
        }
        if (url.endsWith('/upload/v1/file/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { reuse: false, preuploadID: 'preupload-1', sliceSize: 4 },
          })
        }
        if (url.endsWith('/upload/v1/file/get_upload_url')) {
          const body = JSON.parse(String(init?.body ?? '{}')) as { sliceNo?: number }
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              presignedURL: `https://upload.123pan.example/part-${body.sliceNo}`,
            },
          })
        }
        if (url === 'https://upload.123pan.example/part-1') {
          return new Response(null, { status: 200 })
        }
        if (url === 'https://upload.123pan.example/part-2') {
          return new Response(null, { status: 500, statusText: 'rate limited' })
        }

        throw new Error(`Unexpected request: ${url}`)
      },
    })

    await expect(provider.uploadAsset(request)).rejects.toMatchObject({
      diagnostics: {
        retry: {
          recentLogs: [
            expect.objectContaining({
              httpStatus: 500,
              message: '123Pan PUT upload failed with 500 rate limited.',
              uploadedBytes: 4,
              totalBytes: 12,
            }),
          ],
        },
      },
    })
  })

  it('captures invalid JSON responses with redacted body excerpts', async () => {
    const request = await createUploadRequest()
    const directory = await createTempDirectory()

    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: path.join(directory, 'token-cache.json'),
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'token-1',
              expiredAt: '2026-04-10T01:00:00.000Z',
            },
          })
        }
        if (url.includes('/api/v2/file/list')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { lastFileId: '-1', fileList: [] },
          })
        }
        if (url.endsWith('/upload/v1/file/mkdir')) {
          return new Response('token=secret-value', {
            status: 502,
            headers: {
              'Content-Type': 'text/plain',
              Authorization: 'Bearer should-not-leak',
            },
          })
        }

        throw new Error(`Unexpected request: ${url}`)
      },
    })

    await expect(provider.uploadAsset(request)).rejects.toMatchObject({
      diagnostics: {
        request: {
          path: '/upload/v1/file/mkdir',
        },
        response: {
          status: 502,
          headers: {
            authorization: '[redacted]',
          },
          bodyExcerpt: 'token=[redacted]',
        },
        transport: {
          type: 'invalid_json',
        },
      },
    })
  })

  it('captures network exceptions with transport causes', async () => {
    const request = await createUploadRequest()
    const directory = await createTempDirectory()

    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: path.join(directory, 'token-cache.json'),
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/v1/access_token')) {
          const socketError = new Error('socket hang up')
          throw new TypeError('fetch failed', { cause: socketError })
        }

        throw new Error(`Unexpected request: ${url}`)
      },
    })

    await expect(provider.uploadAsset(request)).rejects.toMatchObject({
      diagnostics: {
        request: {
          path: '/api/v1/access_token',
        },
        transport: {
          type: 'network',
          message: 'fetch failed',
          causes: ['fetch failed', 'socket hang up'],
        },
      },
    })
  })

  it('captures polling retry counters when async upload never completes', async () => {
    const request = await createUploadRequest()
    const directory = await createTempDirectory()

    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: path.join(directory, 'token-cache.json'),
      sleep: async () => {},
      maxUploadStatusPolls: 2,
      uploadPollIntervalMs: 50,
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'token-1',
              expiredAt: '2026-04-10T01:00:00.000Z',
            },
          })
        }
        if (url.includes('/api/v2/file/list')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { lastFileId: '-1', fileList: [] },
          })
        }
        if (url.endsWith('/upload/v1/file/mkdir')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { list: [{ filename: 'syncer', dirID: 'target-dir' }] },
          })
        }
        if (url.endsWith('/upload/v1/file/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { reuse: false, preuploadID: 'preupload-1', sliceSize: 1024 },
          })
        }
        if (url.endsWith('/upload/v1/file/get_upload_url')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { presignedURL: 'https://upload.123pan.example/part-1' },
          })
        }
        if (url === 'https://upload.123pan.example/part-1') {
          return new Response(null, { status: 200 })
        }
        if (url.endsWith('/upload/v1/file/upload_complete')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { async: true, completed: false },
          })
        }
        if (url.endsWith('/upload/v1/file/upload_async_result')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { completed: false },
          })
        }

        throw new Error(`Unexpected request: ${url}`)
      },
    })

    await expect(provider.uploadAsset(request)).rejects.toMatchObject({
      diagnostics: {
        request: {
          path: '/upload/v1/file/upload_async_result',
        },
        retry: {
          attempts: 2,
          maxAttempts: 2,
          intervalMs: 50,
          recentLogs: [
            expect.objectContaining({
              attempt: 2,
              message: 'Upload is still processing.',
              uploadedBytes: 12,
              totalBytes: 12,
            }),
            expect.objectContaining({
              attempt: 1,
              message: 'Upload is still processing.',
              uploadedBytes: 12,
              totalBytes: 12,
            }),
          ],
        },
      },
    })
  })

  it('keeps only the most recent three polling logs when async upload times out', async () => {
    const request = await createUploadRequest()
    const directory = await createTempDirectory()

    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: path.join(directory, 'token-cache.json'),
      sleep: async () => {},
      maxUploadStatusPolls: 5,
      uploadPollIntervalMs: 50,
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'token-1',
              expiredAt: '2026-04-10T01:00:00.000Z',
            },
          })
        }
        if (url.includes('/api/v2/file/list')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { lastFileId: '-1', fileList: [] },
          })
        }
        if (url.endsWith('/upload/v1/file/mkdir')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { list: [{ filename: 'syncer', dirID: 'target-dir' }] },
          })
        }
        if (url.endsWith('/upload/v1/file/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { reuse: false, preuploadID: 'preupload-1', sliceSize: 1024 },
          })
        }
        if (url.endsWith('/upload/v1/file/get_upload_url')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { presignedURL: 'https://upload.123pan.example/part-1' },
          })
        }
        if (url === 'https://upload.123pan.example/part-1') {
          return new Response(null, { status: 200 })
        }
        if (url.endsWith('/upload/v1/file/upload_complete')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { async: true, completed: false },
          })
        }
        if (url.endsWith('/upload/v1/file/upload_async_result')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { completed: false },
          })
        }

        throw new Error(`Unexpected request: ${url}`)
      },
    })

    const error = (await provider.uploadAsset(request).catch(
      (cause) => cause as Pan123FailureLike,
    )) as Pan123FailureLike

    expect(error.diagnostics?.retry?.recentLogs).toHaveLength(3)
    expect(
      error.diagnostics?.retry?.recentLogs?.map((log) => log.attempt),
    ).toEqual([5, 4, 3])
  })

  it('redacts sensitive values in recent upload log messages', async () => {
    const request = await createUploadRequest()
    const directory = await createTempDirectory()

    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: path.join(directory, 'token-cache.json'),
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'token-1',
              expiredAt: '2026-04-10T01:00:00.000Z',
            },
          })
        }
        if (url.includes('/api/v2/file/list')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { lastFileId: '-1', fileList: [] },
          })
        }
        if (url.endsWith('/upload/v1/file/mkdir')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { list: [{ filename: 'syncer', dirID: 'target-dir' }] },
          })
        }
        if (url.endsWith('/upload/v1/file/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { reuse: false, preuploadID: 'preupload-1', sliceSize: 1024 },
          })
        }
        if (url.endsWith('/upload/v1/file/get_upload_url')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { presignedURL: 'https://upload.123pan.example/part-1' },
          })
        }
        if (url === 'https://upload.123pan.example/part-1') {
          throw new TypeError('fetch failed token=secret-value')
        }

        throw new Error(`Unexpected request: ${url}`)
      },
    })

    const error = (await provider.uploadAsset(request).catch(
      (cause) => cause as Pan123FailureLike,
    )) as Pan123FailureLike

    expect(error.diagnostics?.retry?.recentLogs?.[0]?.message).toBe(
      'fetch failed token=[redacted]',
    )
  })

  it('omits verbose headers and body excerpts in summary detail mode', async () => {
    const request = await createUploadRequest()
    const directory = await createTempDirectory()

    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: path.join(directory, 'token-cache.json'),
      errorDetailLevel: 'summary',
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse(
            { code: 40101, message: 'invalid credentials', data: null },
            401,
          )
        }

        throw new Error(`Unexpected request: ${url}`)
      },
    })

    const error = await provider.uploadAsset(request).catch(
      (cause) => cause as Pan123FailureLike,
    )

    const diagnostics = (error as Pan123FailureLike).diagnostics
    expect(diagnostics?.provider?.code).toBe(40101)
    expect(diagnostics?.response?.headers).toBeUndefined()
    expect(diagnostics?.response?.bodyExcerpt).toBeUndefined()
  })

  it('reuses an existing active share when a duplicate filename upload fails', async () => {
    const request = await createUploadRequest('powershell-7.6.0-osx-arm64.tar.gz')
    const directory = await createTempDirectory()
    let shareCreateCallCount = 0

    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: path.join(directory, 'token-cache.json'),
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'token-1',
              expiredAt: '2026-04-10T01:00:00.000Z',
            },
          })
        }
        if (url.includes('/api/v2/file/list')) {
          const parentFileId = getSearchParam(url, 'parentFileId')
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              lastFileId: '-1',
              fileList:
                parentFileId === '0'
                  ? []
                  : [
                      {
                        fileId: 'existing-file-1',
                        filename: 'powershell-7.6.0-osx-arm64.tar.gz',
                        size: 12,
                        type: 0,
                      },
                    ],
            },
          })
        }
        if (url.endsWith('/upload/v1/file/mkdir')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { list: [{ filename: 'ollama', dirID: 'target-dir' }] },
          })
        }
        if (url.endsWith('/upload/v1/file/create')) {
          return createJsonResponse({
            code: 5060,
            message: '该目录下文件名重复无法创建',
            data: null,
          })
        }
        if (url.includes('/api/v1/share/list')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              lastShareId: -1,
              shareList: [
                {
                  shareId: 87187529,
                  shareKey: 'PvitVv-older',
                  shareName: 'powershell-7.6.0-osx-arm64.tar.gz',
                  expired: 0,
                },
                {
                  shareId: 87187530,
                  shareKey: 'PvitVv-existing',
                  shareName: 'powershell-7.6.0-osx-arm64.tar.gz',
                  expired: 0,
                },
              ],
            },
          })
        }
        if (url.endsWith('/api/v1/share/create')) {
          shareCreateCallCount += 1
          throw new Error('share/create should not be called when an active share already exists')
        }

        throw new Error(`Unexpected request: ${url}`)
      },
    })

    await expect(provider.uploadAsset(request)).resolves.toEqual({
      providerName: '123pan',
      remoteFileId: 'existing-file-1',
      shareUrl: 'https://www.123pan.com/s/PvitVv-existing',
      uploadedAt: expect.any(String),
    })
    expect(shareCreateCallCount).toBe(0)
  })

  it('creates a new share when duplicate filename upload fails and no active share exists', async () => {
    const request = await createUploadRequest('powershell-7.6.0-osx-arm64.tar.gz')
    const directory = await createTempDirectory()
    let createShareRequest:
      | {
          body: {
            fileIDList?: string
            shareName?: string
            shareExpire?: number
          }
        }
      | undefined

    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: path.join(directory, 'token-cache.json'),
      fetch: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'token-1',
              expiredAt: '2026-04-10T01:00:00.000Z',
            },
          })
        }
        if (url.includes('/api/v2/file/list')) {
          const parentFileId = getSearchParam(url, 'parentFileId')
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              lastFileId: '-1',
              fileList:
                parentFileId === '0'
                  ? []
                  : [
                      {
                        fileId: 'existing-file-1',
                        filename: 'powershell-7.6.0-osx-arm64.tar.gz',
                        size: 12,
                        type: 0,
                      },
                    ],
            },
          })
        }
        if (url.endsWith('/upload/v1/file/mkdir')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { list: [{ filename: 'ollama', dirID: 'target-dir' }] },
          })
        }
        if (url.endsWith('/upload/v1/file/create')) {
          return createJsonResponse({
            code: 5060,
            message: '该目录下文件名重复无法创建',
            data: null,
          })
        }
        if (url.includes('/api/v1/share/list')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              lastShareId: -1,
              shareList: [
                {
                  shareId: 87187520,
                  shareKey: 'PvitVv-expired',
                  shareName: 'powershell-7.6.0-osx-arm64.tar.gz',
                  expired: 1,
                },
              ],
            },
          })
        }
        if (url.endsWith('/api/v1/share/create')) {
          createShareRequest = {
            body: JSON.parse(String(init?.body ?? '{}')) as {
              fileIDList?: string
              shareName?: string
              shareExpire?: number
            },
          }

          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              shareID: 87187530,
              shareKey: 'PvitVv-duplicate',
            },
          })
        }

        throw new Error(`Unexpected request: ${url}`)
      },
    })

    await expect(provider.uploadAsset(request)).resolves.toEqual({
      providerName: '123pan',
      remoteFileId: 'existing-file-1',
      shareUrl: 'https://www.123pan.com/s/PvitVv-duplicate',
      uploadedAt: expect.any(String),
    })
    expect(createShareRequest?.body).toEqual({
      shareName: 'powershell-7.6.0-osx-arm64.tar.gz',
      shareExpire: 0,
      fileIDList: 'existing-file-1',
    })
  })

  it('normalizes share-link creation failures after a successful upload', async () => {
    const request = await createUploadRequest()
    const directory = await createTempDirectory()

    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: path.join(directory, 'token-cache.json'),
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'token-1',
              expiredAt: '2026-04-10T01:00:00.000Z',
            },
          })
        }
        if (url.includes('/api/v2/file/list')) {
          const parentFileId = getSearchParam(url, 'parentFileId')
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              lastFileId: '-1',
              fileList:
                parentFileId === '0'
                  ? []
                  : [
                      {
                        fileId: 'target-dir',
                        filename: 'syncer',
                        type: 1,
                      },
                    ],
            },
          })
        }
        if (url.endsWith('/upload/v1/file/mkdir')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              list: [{ filename: 'syncer', dirID: 'target-dir' }],
            },
          })
        }
        if (url.endsWith('/upload/v1/file/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { reuse: true, fileID: 'remote-file-1' },
          })
        }
        if (url.endsWith('/api/v1/share/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              shareID: 87187530,
            },
          })
        }

        throw new Error(`Unexpected request: ${url}`)
      },
    })

    await expect(
      provider.uploadAsset({
        ...request,
        destination: { repositoryKey: request.destination.repositoryKey, targetDirectory: '/syncer' },
      }),
    ).rejects.toThrow(/123pan share failed/i)
  })
})
