import { createHash } from 'node:crypto'
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

function createJsonResponse(body: unknown, status = 200, statusText?: string) {
  return new Response(JSON.stringify(body), {
    status,
    ...(statusText ? { statusText } : {}),
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

function getSearchParam(url: string, key: string) {
  return new URL(url).searchParams.get(key)
}

function getMultipartField(init: RequestInit | undefined, key: string) {
  const body = init?.body
  if (!(body instanceof FormData)) {
    return undefined
  }

  return body.get(key)?.toString()
}

async function getMultipartBytes(init: RequestInit | undefined, key: string) {
  const body = init?.body
  if (!(body instanceof FormData)) {
    return undefined
  }

  const value = body.get(key)
  return value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : undefined
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
          duplicate?: number
          containDir?: boolean
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
            uid: '10001',
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
                      fileId: '123',
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
                dirID: '123',
              },
            ],
          },
        })
      }

      if (url.endsWith('/upload/v2/file/create')) {
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

      if (url.endsWith('/api/v1/share/content-payment/create')) {
        return createJsonResponse({
          code: 0,
          message: 'ok',
          data: { shareID: 87187531, shareKey: 'paid-share-key' },
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
    'uses the v2 file upload API with metadata fields for %s',
    async (assetName) => {
      await expect(captureCreateFileRequest(assetName)).resolves.toMatchObject({
        url: expect.stringContaining('/upload/v2/file/create'),
        body: {
          parentFileID: '123',
          filename: assetName,
          etag: 'md5-hash',
          size: 12,
          type: assetName === 'cover.png' ? 1 : 0,
          containDir: false,
        },
      })

      const request = await captureCreateFileRequest(assetName)
      expect(request?.body.type).toBe(assetName === 'cover.png' ? 1 : 0)
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
      let createPaidShareRequest:
        | {
            body: {
              shareName?: string
              fileIDList?: string
              payAmount?: number
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
                uid: '10001',
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
                    fileId: '123',
                    filename: 'ollama',
                    type: 1,
                  },
                ],
              },
            })
          }

          if (url.endsWith('/upload/v2/file/create')) {
            return createJsonResponse({
              code: 0,
              message: 'ok',
              data: {
                reuse: true,
                fileID: 'remote-file-1',
              },
            })
          }

          if (url.endsWith('/api/v1/share/content-payment/create')) {
            createPaidShareRequest = {
              body: JSON.parse(String(init?.body ?? '{}')) as {
                shareName?: string
                fileIDList?: string
                payAmount?: number
              },
            }
            return createJsonResponse({
              code: 0,
              message: 'ok',
              data: { shareID: 87187531, shareKey: 'paid-share-key' },
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
      expect(createPaidShareRequest).toEqual({
        body: {
          shareName: assetName,
          fileIDList: 'remote-file-1',
          payAmount: 2,
        },
      })
    },
  )

  it('preserves the Chinese share name used by the official paid-share example', async () => {
    const request = await createUploadRequest('测试付费分享链接.zip')
    const directory = await createTempDirectory()
    let paidShareBody: Record<string, unknown> | undefined

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
              uid: '10001',
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
              fileList: [{ fileId: '123', filename: 'ollama', type: 1 }],
            },
          })
        }

        if (url.endsWith('/upload/v1/file/mkdir')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { list: [{ filename: 'ollama', dirID: '123' }] },
          })
        }

        if (url.endsWith('/upload/v2/file/create')) {
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
            data: { shareID: 1, shareKey: 'share-key' },
          })
        }

        if (url.endsWith('/api/v1/share/content-payment/create')) {
          paidShareBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { shareID: 2, shareKey: 'paid-key' },
          })
        }

        throw new Error(`Unexpected request: ${url}`)
      },
    })

    await expect(provider.uploadAsset(request)).resolves.toMatchObject({
      paidShareUrl: 'https://10001.share.123pan.cn/123pan/paid-key',
    })
    expect(paidShareBody).toEqual({
      shareName: '测试付费分享链接.zip',
      fileIDList: 'remote-file-1',
      payAmount: 2,
    })
  })

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
              uid: '10001',
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
                        fileId: '124',
                        filename: 'syncer',
                        type: 1,
                      },
                    ]
                  : parentFileId === '124'
                    ? [
                        {
                          fileId: '125',
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
                  dirID: body.name === 'v0.6.0' ? '126' : `dir-${body.name}`,
                },
              ],
            },
          })
        }

        if (url.endsWith('/upload/v2/file/create')) {
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

        if (url.endsWith('/api/v1/share/content-payment/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { shareID: 87187531, shareKey: 'paid-share-key' },
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
    expect(createFileRequest?.body.parentFileID).toBe('126')
  })

  it('uploads files and persists a reusable token cache', async () => {
    const request = await createUploadRequest()
    const directory = await createTempDirectory()
    const tokenCachePath = path.join(directory, 'token-cache.json')
    const calls: Array<{ url: string; method: string }> = []
    let sliceRequest:
      | {
          preuploadID?: string
          sliceNo?: string
          sliceMD5?: string
          slice?: Uint8Array
        }
      | undefined

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
              uid: '10001',
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

          if (parentFileId === '124') {
            return createJsonResponse({
              code: 0,
              message: 'ok',
              data: {
                lastFileId: '-1',
                fileList: [
                  {
                    fileId: '125',
                    filename: 'ollama',
                    type: 1,
                  },
                ],
              },
            })
          }

          if (parentFileId === '125') {
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
                  dirID: body.name === 'syncer' ? '124' : '125',
                },
              ],
            },
          })
        }

        if (url.endsWith('/upload/v2/file/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              reuse: false,
              servers: ['https://upload.123pan.example'],
              preuploadID: 'preupload-1',
              sliceSize: 1024,
            },
          })
        }

        if (url.endsWith('/upload/v2/file/slice')) {
          sliceRequest = {
            preuploadID: getMultipartField(init, 'preuploadID'),
            sliceNo: getMultipartField(init, 'sliceNo'),
            sliceMD5: getMultipartField(init, 'sliceMD5'),
            slice: await getMultipartBytes(init, 'slice'),
          }
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {},
          })
        }

        if (url.endsWith('/upload/v2/file/upload_complete')) {
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

        if (url.endsWith('/api/v1/share/content-payment/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { shareID: 87187531, shareKey: 'paid-share-key' },
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
      paidShareUrl: 'https://10001.share.123pan.cn/123pan/paid-share-key',
      uploadedAt: '2026-04-10T00:00:00.000Z',
    })

    const tokenCache = JSON.parse(await readFile(tokenCachePath, 'utf8')) as {
      accessToken: string
    }
    expect(tokenCache.accessToken).toBe('token-1')
    expect(calls.filter((call) => call.url.endsWith('/api/v1/access_token'))).toHaveLength(1)
    expect(sliceRequest).toMatchObject({
      preuploadID: 'preupload-1',
      sliceNo: '1',
      sliceMD5: createHash('md5').update('hello ollama').digest('hex'),
    })
    expect(sliceRequest?.slice).toEqual(new Uint8Array(Buffer.from('hello ollama')))
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
              uid: '10001',
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
                        fileId: '123',
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
                  dirID: '123',
                },
              ],
            },
          })
        }

        if (url.endsWith('/upload/v2/file/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              reuse: true,
              fileID: 'reused-file',
            },
          })
        }

        if (url.endsWith('/api/v1/share/content-payment/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { shareID: 87187531, shareKey: 'paid-share-key' },
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

  it.each<[string, number, RegExp]>([
    ['a/name.tar.gz', 12, /filenames must be shorter than 255/i],
    ['', 12, /filenames must be shorter than 255/i],
    ['valid-name.tar.gz', -1, /files must not exceed 10gb/i],
    ['valid-name.tar.gz', 10 * 1024 * 1024 * 1024 + 1, /files must not exceed 10gb/i],
  ])('rejects invalid upload metadata before network access', async (assetName, byteSize, message) => {
    const request = await createUploadRequest('valid-name.tar.gz')
    const directory = await createTempDirectory()
    let fetchCallCount = 0
    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: path.join(directory, 'token-cache.json'),
      fetch: async () => {
        fetchCallCount += 1
        throw new Error('network access should not occur')
      },
    })

    await expect(
      provider.uploadAsset({
        ...request,
        asset: { ...request.asset, assetName },
        file: { ...request.file, byteSize },
      }),
    ).rejects.toThrow(message)
    expect(fetchCallCount).toBe(0)
  })

  it('uploads a file through the v2 single-step multipart path', async () => {
    const request = await createUploadRequest('cover.png')
    const directory = await createTempDirectory()
    const calls: string[] = []
    let singleRequest:
      | {
          parentFileID?: string
          filename?: string
          etag?: string
          size?: string
          duplicate?: string
          containDir?: string
          file?: Uint8Array
        }
      | undefined

    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: path.join(directory, 'token-cache.json'),
      singleStepUpload: true,
      duplicate: 2,
      containDir: true,
      now: () => new Date('2026-04-10T00:00:00.000Z'),
      fetch: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString()
        calls.push(url)

        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'token-1',
              uid: '10001',
              expiredAt: '2026-04-10T01:00:00.000Z',
            },
          })
        }
        if (url.endsWith('/upload/v2/file/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { reuse: false, servers: ['https://upload.123pan.example'] },
          })
        }
        if (url.endsWith('/upload/v2/file/domain')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: ['https://upload.123pan.example'],
          })
        }
        if (url.endsWith('/upload/v2/file/single/create')) {
          singleRequest = {
            parentFileID: getMultipartField(init, 'parentFileID'),
            filename: getMultipartField(init, 'filename'),
            etag: getMultipartField(init, 'etag'),
            size: getMultipartField(init, 'size'),
            duplicate: getMultipartField(init, 'duplicate'),
            containDir: getMultipartField(init, 'containDir'),
            file: await getMultipartBytes(init, 'file'),
          }
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { fileID: 'single-file' },
          })
        }
        if (url.endsWith('/api/v1/share/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { shareID: 1, shareKey: 'share-key' },
          })
        }
        if (url.endsWith('/api/v1/share/content-payment/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { shareID: 2, shareKey: 'paid-key' },
          })
        }
        throw new Error(`Unexpected request: ${url}`)
      },
    })
    await expect(
      provider.uploadAsset({
        ...request,
        destination: { ...request.destination, targetDirectory: '/' },
      }),
    ).resolves.toMatchObject({
      remoteFileId: 'single-file',
      paidShareUrl: 'https://10001.share.123pan.cn/123pan/paid-key',
    })
    expect(singleRequest).toMatchObject({
      parentFileID: '0',
      filename: 'cover.png',
      etag: createHash('md5').update('hello ollama').digest('hex'),
      size: '12',
      duplicate: '2',
      containDir: 'true',
    })
    expect(singleRequest?.file).toEqual(new Uint8Array(Buffer.from('hello ollama')))
    expect(calls.some((url) => url.endsWith('/upload/v2/file/slice'))).toBe(false)
    expect(calls.some((url) => url.endsWith('/upload/v2/file/upload_complete'))).toBe(false)
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
      sleep: async () => {},
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'token-1',
              uid: '10001',
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
        retry: {
          attempts: 3,
          maxAttempts: 3,
          intervalMs: 4000,
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
      sleep: async () => {},
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'token-1',
              uid: '10001',
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
            data: { list: [{ filename: 'syncer', dirID: '123' }] },
          })
        }
        if (url.endsWith('/upload/v2/file/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { reuse: false, servers: ['https://upload.123pan.example'], preuploadID: 'preupload-1', sliceSize: 1024 },
          })
        }
        if (url.endsWith('/upload/v2/file/slice')) {
          return createJsonResponse(
            { code: 500, message: 'broken upload', data: null },
            500,
            'broken upload',
          )
        }
        throw new Error(`Unexpected request: ${url}`)
      },
    })
    await expect(provider.uploadAsset(request)).rejects.toThrow(/123pan upload failed/i)
    await expect(provider.uploadAsset(request)).rejects.toMatchObject({
      diagnostics: {
        request: {
          method: 'POST',
          host: 'upload.123pan.example',
          path: '/upload/v2/file/slice',
        },
        response: {
          status: 500,
          statusText: 'broken upload',
        },
        retry: {
          attempts: 3,
          maxAttempts: 3,
          intervalMs: 4000,
        },
      },
    })
  })
  it('captures recent upload progress for failed multipart uploads', async () => {
    const request = await createUploadRequest()
    const directory = await createTempDirectory()
    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: path.join(directory, 'token-cache.json'),
      sleep: async () => {},
      fetch: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'token-1',
              uid: '10001',
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
            data: { list: [{ filename: 'syncer', dirID: '123' }] },
          })
        }
        if (url.endsWith('/upload/v2/file/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { reuse: false, servers: ['https://upload.123pan.example'], preuploadID: 'preupload-1', sliceSize: 4 },
          })
        }
        if (url.endsWith('/upload/v2/file/slice')) {
          const sliceNo = getMultipartField(init, 'sliceNo')
          if (sliceNo === '1') {
            return createJsonResponse({ code: 0, message: 'ok', data: {} })
          }
          return createJsonResponse(
            { code: 500, message: 'rate limited', data: null },
            500,
          )
        }
        throw new Error(`Unexpected request: ${url}`)
      },
    })
    await expect(provider.uploadAsset(request)).rejects.toMatchObject({
      diagnostics: {
        retry: {
          attempts: 3,
          maxAttempts: 3,
          intervalMs: 4000,
          recentLogs: [
            expect.objectContaining({
              attempt: 3,
              httpStatus: 500,
              message: 'rate limited',
              uploadedBytes: 4,
              totalBytes: 12,
            }),
            expect.objectContaining({
              attempt: 2,
              httpStatus: 500,
            }),
            expect.objectContaining({
              attempt: 1,
              httpStatus: 500,
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
              uid: '10001',
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
              uid: '10001',
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
            data: { list: [{ filename: 'syncer', dirID: '123' }] },
          })
        }
        if (url.endsWith('/upload/v2/file/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { reuse: false, servers: ['https://upload.123pan.example'], preuploadID: 'preupload-1', sliceSize: 1024 },
          })
        }
        if (url.endsWith('/upload/v2/file/slice')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {},
          })
        }
        if (url.endsWith('/upload/v2/file/upload_complete')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { async: true, completed: false },
          })
        }
        throw new Error(`Unexpected request: ${url}`)
      },
    })
    await expect(provider.uploadAsset(request)).rejects.toMatchObject({
      diagnostics: {
        request: {
          path: '/upload/v2/file/upload_complete',
        },
        retry: {
          attempts: 3,
          maxAttempts: 3,
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
              uid: '10001',
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
            data: { list: [{ filename: 'syncer', dirID: '123' }] },
          })
        }
        if (url.endsWith('/upload/v2/file/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { reuse: false, servers: ['https://upload.123pan.example'], preuploadID: 'preupload-1', sliceSize: 1024 },
          })
        }
        if (url.endsWith('/upload/v2/file/slice')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {},
          })
        }
        if (url.endsWith('/upload/v2/file/upload_complete')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { async: true, completed: false },
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
      sleep: async () => {},
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'token-1',
              uid: '10001',
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
            data: { list: [{ filename: 'syncer', dirID: '123' }] },
          })
        }
        if (url.endsWith('/upload/v2/file/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { reuse: false, servers: ['https://upload.123pan.example'], preuploadID: 'preupload-1', sliceSize: 1024 },
          })
        }
        if (url.endsWith('/upload/v2/file/slice')) {
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
    expect(error.diagnostics?.retry?.recentLogs?.[0]?.attempt).toBe(3)
  })
  it('retries transient directory creation failures and eventually succeeds', async () => {
    const request = await createUploadRequest()
    const directory = await createTempDirectory()
    let mkdirCallCount = 0
    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: path.join(directory, 'token-cache.json'),
      sleep: async () => {},
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'token-1',
              uid: '10001',
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
          mkdirCallCount += 1
          if (mkdirCallCount < 3) {
            return createJsonResponse({ code: 500, message: 'mkdir failed', data: null })
          }
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { list: [{ filename: 'syncer', dirID: '123' }] },
          })
        }
        if (url.endsWith('/upload/v2/file/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { reuse: true, fileID: 'remote-file-1' },
          })
        }
        if (url.endsWith('/api/v1/share/content-payment/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { shareID: 87187531, shareKey: 'paid-share-key' },
          })
        }
        if (url.endsWith('/api/v1/share/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { shareID: 1, shareKey: 'share-key' },
          })
        }

        throw new Error(`Unexpected request: ${url}`)
      },
    })

    await expect(provider.uploadAsset(request)).resolves.toMatchObject({
      providerName: '123pan',
      remoteFileId: 'remote-file-1',
      shareUrl: 'https://www.123pan.com/s/share-key',
    })
    expect(mkdirCallCount).toBe(4)
  })

  it('retries transient multipart upload failures and eventually succeeds', async () => {
    const request = await createUploadRequest()
    const directory = await createTempDirectory()
    let sliceCallCount = 0

    const provider = createPan123NetdiskProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCachePath: path.join(directory, 'token-cache.json'),
      sleep: async () => {},
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/v1/access_token')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'token-1',
              uid: '10001',
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
            data: { list: [{ filename: 'syncer', dirID: '123' }] },
          })
        }
        if (url.endsWith('/upload/v2/file/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { reuse: false, servers: ['https://upload.123pan.example'], preuploadID: 'preupload-1', sliceSize: 1024 },
          })
        }
        if (url.endsWith('/upload/v2/file/slice')) {
          sliceCallCount += 1
          if (sliceCallCount < 3) {
            return createJsonResponse(
              { code: 500, message: 'temporary failure', data: null },
              500,
              'temporary failure',
            )
          }

          return createJsonResponse({ code: 0, message: 'ok', data: {} })
        }
        if (url.endsWith('/upload/v2/file/upload_complete')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { async: false, completed: true, fileID: 'remote-file-1' },
          })
        }
        if (url.endsWith('/api/v1/share/content-payment/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { shareID: 87187531, shareKey: 'paid-share-key' },
          })
        }
        if (url.endsWith('/api/v1/share/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { shareID: 1, shareKey: 'share-key' },
          })
        }

        throw new Error(`Unexpected request: ${url}`)
      },
    })

    await expect(provider.uploadAsset(request)).resolves.toMatchObject({
      providerName: '123pan',
      remoteFileId: 'remote-file-1',
      shareUrl: 'https://www.123pan.com/s/share-key',
    })
    expect(sliceCallCount).toBe(3)
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
              uid: '10001',
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
            data: { list: [{ filename: 'ollama', dirID: '123' }] },
          })
        }
        if (url.endsWith('/upload/v2/file/create')) {
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
        if (url.endsWith('/api/v1/share/content-payment/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { shareID: 87187531, shareKey: 'paid-share-key' },
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
      paidShareUrl: 'https://10001.share.123pan.cn/123pan/paid-share-key',
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
              uid: '10001',
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
            data: { list: [{ filename: 'ollama', dirID: '123' }] },
          })
        }
        if (url.endsWith('/upload/v2/file/create')) {
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
        if (url.endsWith('/api/v1/share/content-payment/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { shareID: 87187531, shareKey: 'paid-share-key' },
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
      paidShareUrl: 'https://10001.share.123pan.cn/123pan/paid-share-key',
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
              uid: '10001',
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
                        fileId: '123',
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
              list: [{ filename: 'syncer', dirID: '123' }],
            },
          })
        }
        if (url.endsWith('/upload/v2/file/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { reuse: true, fileID: 'remote-file-1' },
          })
        }
        if (url.endsWith('/api/v1/share/content-payment/create')) {
          return createJsonResponse({
            code: 0,
            message: 'ok',
            data: { shareID: 87187531, shareKey: 'paid-share-key' },
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
