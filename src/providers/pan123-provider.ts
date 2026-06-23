import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  NetdiskProviderError,
  createNetdiskProviderError,
  type NetdiskProvider,
} from '../netdisk-provider'
import {
  type NetdiskErrorDetailLevel,
  type NetdiskFailureDiagnostics,
  type NetdiskFailureRecentLogEntry,
  type NetdiskFailureRedactionDiagnostics,
  type NetdiskFailureRequestDiagnostics,
  type NetdiskFailureResponseDiagnostics,
  type NetdiskFailureTransportDiagnostics,
  type NetdiskUploadRequest,
} from '../release-sync-contracts'

const providerName = '123pan'
const defaultApiBaseUrl = 'https://open-api.123pan.com'
const defaultShareBaseUrl = 'https://www.123pan.com/s/'
const permanentShareExpireDays = 0
const defaultUploadPollIntervalMs = 1000
const defaultMaxUploadStatusPolls = 30
const defaultTransientRetryMaxAttempts = 3
const defaultTransientRetryBaseDelayMs = 1000
const tokenRefreshSafetyWindowMs = 60_000
const duplicateFileNameErrorMessage = '该目录下文件名重复无法创建'
const maxDiagnosticBodyLength = 400
const maxRecentUploadLogs = 3
type Pan123FileId = string | number

interface Pan123UploadLogContext {
  latestUploadedBytes: number | null
  totalBytes: number
  recentLogs: NetdiskFailureRecentLogEntry[]
}

interface Pan123ApiResponse<T> {
  code: number
  message: string
  data: T | null
}

interface Pan123AccessTokenPayload {
  accessToken: string
  expiredAt: string
}

interface Pan123TokenCachePayload extends Pan123AccessTokenPayload {
  providerName: '123pan'
  updatedAt: string
}

interface Pan123CreateDirectoryResponse {
  list?: Array<{
    filename?: string
    dirID?: Pan123FileId
  }>
}

interface Pan123CreateFileResponse {
  fileID?: Pan123FileId
  preuploadID?: string
  reuse: boolean
  sliceSize?: number
}

interface Pan123UploadUrlResponse {
  presignedURL: string
}

interface Pan123UploadCompleteResponse {
  async?: boolean
  completed: boolean
  fileID?: Pan123FileId
}

interface Pan123UploadAsyncResultResponse {
  completed: boolean
  fileID?: Pan123FileId
}

interface Pan123CreateShareResponse {
  shareID?: number
  shareKey?: string
}

interface Pan123ShareListResponse {
  lastShareId?: number
  shareList?: Pan123ShareRecord[]
}

interface Pan123ShareRecord {
  shareId?: number
  shareKey?: string
  shareName?: string
  expired?: number
}

interface Pan123ListFilesResponse {
  lastFileId?: Pan123FileId
  fileList?: Pan123RemoteFile[]
}

interface Pan123RemoteFile {
  fileId: Pan123FileId
  filename: string
  type: number
  size?: number
  etag?: string
  createAt?: string
  updateAt?: string
  downloadURL?: string
  userSelfURL?: string
  parentFileId?: Pan123FileId
}

export interface Pan123ProviderOptions {
  clientId: string
  clientSecret: string
  tokenCachePath: string
  errorDetailLevel?: NetdiskErrorDetailLevel
  apiBaseUrl?: string
  now?: () => Date
  fetch?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
  uploadPollIntervalMs?: number
  maxUploadStatusPolls?: number
}

function normalizeApiBaseUrl(value: string | undefined) {
  return (value ?? defaultApiBaseUrl).replace(/\/+$/, '')
}

function normalizeTargetDirectory(value: string | undefined) {
  const parts = (value ?? '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)

  return parts.length === 0 ? '/' : `/${parts.join('/')}`
}

async function defaultSleep(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isTokenStillValid(payload: Pan123TokenCachePayload, now: Date) {
  const expiresAt = Date.parse(payload.expiredAt)
  return Number.isFinite(expiresAt) && expiresAt - now.getTime() > tokenRefreshSafetyWindowMs
}

function isDuplicateFileNameError(error: unknown) {
  if (!(error instanceof Error)) {
    return false
  }

  return error.message.includes(duplicateFileNameErrorMessage)
}

function collectErrorCauses(error: unknown) {
  const messages: string[] = []
  let current: unknown = error
  while (current instanceof Error) {
    messages.push(current.message)
    current = current.cause
  }

  return [...new Set(messages.filter(Boolean))]
}

function trimText(value: string | null | undefined) {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

function redactSensitiveText(value: string) {
  return value
    .replace(
      /((?:authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|signature|token|sig)["'\s:=]+)([^"',\s}]+)/gi,
      '$1[redacted]',
    )
    .replace(/(Bearer\s+)([^\s]+)/gi, '$1[redacted]')
}

function sanitizeBodyExcerpt(value: string | null | undefined) {
  const normalized = trimText(value)
  if (!normalized) {
    return {
      bodyExcerpt: null,
      bodyTruncated: false,
    }
  }

  const redacted = redactSensitiveText(normalized)
  const bodyTruncated = redacted.length > maxDiagnosticBodyLength
  return {
    bodyExcerpt: bodyTruncated
      ? `${redacted.slice(0, maxDiagnosticBodyLength)}...`
      : redacted,
    bodyTruncated,
  }
}

function isSensitiveHeader(headerName: string) {
  return /authorization|cookie|token|secret|signature|set-cookie|x-amz|x-ms/i.test(
    headerName,
  )
}

function sanitizeHeaders(headers: Headers) {
  const sanitized: Record<string, string> = {}
  const headersRedacted: string[] = []

  for (const [key, value] of headers.entries()) {
    if (isSensitiveHeader(key)) {
      sanitized[key] = '[redacted]'
      headersRedacted.push(key)
      continue
    }

    sanitized[key] = redactSensitiveText(value)
  }

  return {
    headers: Object.keys(sanitized).length > 0 ? sanitized : undefined,
    headersRedacted,
  }
}

function buildRequestDiagnostics(url: URL, method: string): NetdiskFailureRequestDiagnostics {
  return {
    method,
    host: url.host,
    path: url.pathname,
    query: url.search ? '[redacted]' : null,
  }
}

function sanitizeRecentLogMessage(value: string | null | undefined) {
  const normalized = trimText(value)
  return normalized ? redactSensitiveText(normalized) : 'Unknown upload error.'
}

function createUploadLogContext(totalBytes: number): Pan123UploadLogContext {
  return {
    latestUploadedBytes: 0,
    totalBytes,
    recentLogs: [],
  }
}

function updateUploadProgress(
  context: Pan123UploadLogContext,
  uploadedBytes: number | null | undefined,
) {
  if (uploadedBytes == null || !Number.isFinite(uploadedBytes)) {
    return
  }

  context.latestUploadedBytes = Math.min(
    context.totalBytes,
    Math.max(0, Math.trunc(uploadedBytes)),
  )
}

function appendRecentUploadLog(
  context: Pan123UploadLogContext,
  input: {
    occurredAt: string
    attempt?: number
    httpStatus?: number | null
    statusText?: string | null
    message: string
    uploadedBytes?: number | null
  },
) {
  const uploadedBytes =
    input.uploadedBytes == null ? context.latestUploadedBytes : input.uploadedBytes

  context.recentLogs = [
    removeEmptyEntries({
      occurredAt: input.occurredAt,
      attempt: input.attempt,
      httpStatus: input.httpStatus ?? undefined,
      statusText: trimText(input.statusText ?? undefined),
      message: sanitizeRecentLogMessage(input.message),
      uploadedBytes,
      totalBytes: uploadedBytes == null ? undefined : context.totalBytes,
    }) as NetdiskFailureRecentLogEntry,
    ...context.recentLogs,
  ].slice(0, maxRecentUploadLogs)
}

function buildRetryDiagnostics(
  retry: NetdiskFailureDiagnostics['retry'] | undefined,
  context?: Pan123UploadLogContext,
) {
  if (!retry && !context?.recentLogs.length) {
    return undefined
  }

  return removeEmptyEntries({
    ...(retry ?? {}),
    recentLogs: context?.recentLogs.length ? [...context.recentLogs] : undefined,
  }) as NetdiskFailureDiagnostics['retry']
}

function removeEmptyEntries<T extends object>(value: T) {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, entry]) => {
      if (entry == null) {
        return false
      }

      if (Array.isArray(entry)) {
        return entry.length > 0
      }

      if (typeof entry === 'object') {
        return Object.keys(entry as Record<string, unknown>).length > 0
      }

      return true
    }),
  ) as Partial<T>
}

function buildDiagnostics(input: {
  detailLevel: NetdiskErrorDetailLevel
  url: URL
  method: string
  response?: Response
  responseBody?: string | null
  providerCode?: string | number | null
  providerMessage?: string | null
  transport?: NetdiskFailureTransportDiagnostics
  retry?: NetdiskFailureDiagnostics['retry']
}): NetdiskFailureDiagnostics {
  const responseRedaction = input.response
    ? sanitizeHeaders(input.response.headers)
    : { headers: undefined, headersRedacted: [] }
  const bodyExcerpt = sanitizeBodyExcerpt(input.responseBody)
  const response: NetdiskFailureResponseDiagnostics | undefined = input.response
    ? removeEmptyEntries({
        status: input.response.status,
        statusText: trimText(input.response.statusText),
        headers:
          input.detailLevel === 'diagnostic' ? responseRedaction.headers : undefined,
        bodyExcerpt:
          input.detailLevel === 'diagnostic' ? bodyExcerpt.bodyExcerpt : undefined,
      })
    : undefined
  const redaction: NetdiskFailureRedactionDiagnostics = removeEmptyEntries({
    mode: 'sanitized',
    headersRedacted: responseRedaction.headersRedacted,
    queryRedacted: input.url.search.length > 0,
    bodyTruncated: bodyExcerpt.bodyTruncated,
  }) as NetdiskFailureRedactionDiagnostics

  return removeEmptyEntries({
    detailLevel: input.detailLevel,
    request: buildRequestDiagnostics(input.url, input.method),
    response,
    provider: removeEmptyEntries({
      code: input.providerCode ?? null,
      message: trimText(input.providerMessage),
    }),
    transport: input.transport ? removeEmptyEntries(input.transport) : undefined,
    retry: input.retry ? removeEmptyEntries(input.retry) : undefined,
    redaction,
  }) as NetdiskFailureDiagnostics
}

export function createPan123Provider(
  options: Pan123ProviderOptions,
): NetdiskProvider {
  const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl)
  const errorDetailLevel = options.errorDetailLevel ?? 'diagnostic'
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())
  const sleep = options.sleep ?? defaultSleep
  const uploadPollIntervalMs =
    options.uploadPollIntervalMs ?? defaultUploadPollIntervalMs
  const maxUploadStatusPolls =
    options.maxUploadStatusPolls ?? defaultMaxUploadStatusPolls

  function isRetryableStatusCode(status: number | null | undefined) {
    return status != null && (status === 408 || status === 409 || status === 423 || status === 425 || status === 429 || status >= 500)
  }

  function isRetryableProviderCode(code: string | number | null | undefined) {
    if (typeof code === 'number') {
      return isRetryableStatusCode(code)
    }

    if (typeof code !== 'string' || !code.trim()) {
      return false
    }

    const parsed = Number(code)
    return Number.isFinite(parsed) && isRetryableStatusCode(parsed)
  }

  function isRetryableStageError(stage: 'directory' | 'upload', error: unknown) {
    if (!(error instanceof NetdiskProviderError)) {
      return false
    }

    if (error.providerName !== providerName || error.stage !== stage) {
      return false
    }

    const diagnostics = error.diagnostics
    return (
      diagnostics?.transport?.type === 'network' ||
      isRetryableStatusCode(diagnostics?.response?.status) ||
      isRetryableProviderCode(diagnostics?.provider?.code)
    )
  }

  function calculateRetryDelayMs(attempt: number) {
    return defaultTransientRetryBaseDelayMs * 2 ** Math.max(0, attempt - 1)
  }

  async function retryStageOperation<T>(
    stage: 'directory' | 'upload',
    action: (retry: NetdiskFailureDiagnostics['retry']) => Promise<T>,
  ) {
    for (
      let attempt = 1;
      attempt <= defaultTransientRetryMaxAttempts;
      attempt += 1
    ) {
      const retry = {
        attempts: attempt,
        maxAttempts: defaultTransientRetryMaxAttempts,
        intervalMs: calculateRetryDelayMs(attempt),
      } satisfies NetdiskFailureDiagnostics['retry']

      try {
        return await action(retry)
      } catch (error) {
        if (
          attempt >= defaultTransientRetryMaxAttempts ||
          !isRetryableStageError(stage, error)
        ) {
          throw error
        }

        await sleep(retry.intervalMs ?? defaultTransientRetryBaseDelayMs)
      }
    }

    throw new Error(`Retry operation for ${stage} exhausted unexpectedly.`)
  }

  async function requestJson<T>(
    pathname: string,
    body: Record<string, unknown>,
    request: NetdiskUploadRequest,
    stage: 'auth' | 'directory' | 'upload' | 'share',
    token?: string,
    method: 'GET' | 'POST' = 'POST',
    retry?: NetdiskFailureDiagnostics['retry'],
    uploadLogContext?: Pan123UploadLogContext,
  ) {
    let response: Response
    const url = new URL(`${apiBaseUrl}${pathname}`)

    if (method === 'GET') {
      for (const [key, value] of Object.entries(body)) {
        if (value == null) {
          continue
        }

        url.searchParams.set(key, String(value))
      }
    }

    try {
      response = await fetcher(url.toString(), {
        method,
        headers: {
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          Platform: 'open_platform',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
        signal: request.signal,
      })
    } catch (error) {
      if (stage === 'upload' && uploadLogContext) {
        appendRecentUploadLog(uploadLogContext, {
          occurredAt: now().toISOString(),
          attempt: retry?.attempts,
          message: error instanceof Error ? error.message : String(error),
        })
      }

      throw createNetdiskProviderError({
        providerName,
        stage,
        asset: request.asset,
        error,
        diagnostics: buildDiagnostics({
          detailLevel: errorDetailLevel,
          url,
          method,
          transport: {
            type: 'network',
            message: error instanceof Error ? error.message : String(error),
            causes: collectErrorCauses(error),
          },
          retry: buildRetryDiagnostics(retry, uploadLogContext),
        }),
      })
    }

    const responseText = await response.text()
    let payload: Pan123ApiResponse<T>
    try {
      payload = JSON.parse(responseText) as Pan123ApiResponse<T>
    } catch (error) {
      if (stage === 'upload' && uploadLogContext) {
        appendRecentUploadLog(uploadLogContext, {
          occurredAt: now().toISOString(),
          attempt: retry?.attempts,
          httpStatus: response.status,
          statusText: response.statusText,
          message: '123Pan API returned an invalid JSON payload.',
        })
      }

      throw createNetdiskProviderError({
        providerName,
        stage,
        asset: request.asset,
        error: new Error('123Pan API returned an invalid JSON payload.', {
          cause: error,
        }),
        diagnostics: buildDiagnostics({
          detailLevel: errorDetailLevel,
          url,
          method,
          response,
          responseBody: responseText,
          transport: {
            type: 'invalid_json',
            message: '123Pan API returned an invalid JSON payload.',
            causes: collectErrorCauses(error),
          },
          retry: buildRetryDiagnostics(retry, uploadLogContext),
        }),
      })
    }

    if (!response.ok || payload.code !== 0 || payload.data == null) {
      const message =
        payload.message || `123Pan API returned ${response.status} ${response.statusText}.`
      if (stage === 'upload' && uploadLogContext) {
        appendRecentUploadLog(uploadLogContext, {
          occurredAt: now().toISOString(),
          attempt: retry?.attempts,
          httpStatus: response.status,
          statusText: response.statusText,
          message,
        })
      }

      throw createNetdiskProviderError({
        providerName,
        stage,
        asset: request.asset,
        error: new Error(message),
        diagnostics: buildDiagnostics({
          detailLevel: errorDetailLevel,
          url,
          method,
          response,
          responseBody: responseText,
          providerCode: payload.code,
          providerMessage: payload.message,
          retry: buildRetryDiagnostics(retry, uploadLogContext),
        }),
      })
    }

    return payload.data
  }

  async function readCachedToken() {
    try {
      const contents = await readFile(options.tokenCachePath, 'utf8')
      const payload = JSON.parse(contents) as Pan123TokenCachePayload
      if (payload.providerName !== providerName) {
        return undefined
      }

      return payload
    } catch {
      return undefined
    }
  }

  async function writeCachedToken(payload: Pan123AccessTokenPayload) {
    await mkdir(path.dirname(options.tokenCachePath), { recursive: true })
    await writeFile(
      options.tokenCachePath,
      JSON.stringify(
        {
          providerName,
          accessToken: payload.accessToken,
          expiredAt: payload.expiredAt,
          updatedAt: now().toISOString(),
        } satisfies Pan123TokenCachePayload,
        null,
        2,
      ),
    )
  }

  async function getAccessToken(request: NetdiskUploadRequest) {
    const cachedToken = await readCachedToken()
    if (cachedToken && isTokenStillValid(cachedToken, now())) {
      return cachedToken.accessToken
    }

    const payload = await requestJson<Pan123AccessTokenPayload>(
      '/api/v1/access_token',
      {
        clientID: options.clientId,
        clientSecret: options.clientSecret,
      },
      request,
      'auth',
    )

    await writeCachedToken(payload)
    return payload.accessToken
  }

  async function listDirectory(
    token: string,
    request: NetdiskUploadRequest,
    parentFileId: Pan123FileId,
  ) {
    const files: Pan123RemoteFile[] = []
    let lastFileId: Pan123FileId | undefined

    while (true) {
      const response = await requestJson<Pan123ListFilesResponse>(
        '/api/v2/file/list',
        {
          parentFileId,
          ...(lastFileId ? { lastFileId } : {}),
          limit: 100,
        },
        request,
        'directory',
        token,
        'GET',
      )

      files.push(...(response.fileList ?? []))
      if (response.lastFileId == null || String(response.lastFileId) === '-1') {
        return files
      }

      lastFileId = response.lastFileId
    }
  }

  async function ensureDirectory(
    token: string,
    request: NetdiskUploadRequest,
    targetDirectory: string,
  ) {
    if (targetDirectory === '/') {
      return 0
    }

    let parentId: Pan123FileId = 0

    for (const segment of targetDirectory.split('/').filter(Boolean)) {
      parentId = await retryStageOperation('directory', async (retry) => {
        const entries = await listDirectory(token, request, parentId)
        const existingDirectory = entries.find(
          (entry) => entry.type === 1 && entry.filename === segment,
        )

        if (existingDirectory) {
          return existingDirectory.fileId
        }

        const createdDirectory = await requestJson<Pan123CreateDirectoryResponse>(
          '/upload/v1/file/mkdir',
          {
            name: segment,
            parentID: parentId,
          },
          request,
          'directory',
          token,
          'POST',
          retry,
        )

        const directoryId = createdDirectory.list?.[0]?.dirID
        if (!directoryId) {
          throw createNetdiskProviderError({
            providerName,
            stage: 'directory',
            asset: request.asset,
            error: '123Pan directory creation did not return a dirID.',
            diagnostics: buildDiagnostics({
              detailLevel: errorDetailLevel,
              url: new URL(`${apiBaseUrl}/upload/v1/file/mkdir`),
              method: 'POST',
              retry,
            }),
          })
        }

        return directoryId
      })
    }

    return parentId
  }

  async function uploadFileParts(
    token: string,
    request: NetdiskUploadRequest,
    parentDirectoryId: Pan123FileId,
  ) {
    const uploadLogContext = createUploadLogContext(request.file.byteSize)
    const createdFile = await requestJson<Pan123CreateFileResponse>(
      '/upload/v1/file/create',
      {
        parentFileID: parentDirectoryId,
        filename: request.asset.assetName,
        etag: request.file.md5,
        size: request.file.byteSize,
      },
      request,
      'upload',
      token,
    )

    if (createdFile.reuse) {
      if (!createdFile.fileID) {
        throw createNetdiskProviderError({
          providerName,
          stage: 'upload',
          asset: request.asset,
          error: '123Pan reported a reused upload without a fileID.',
          diagnostics: buildDiagnostics({
            detailLevel: errorDetailLevel,
            url: new URL(`${apiBaseUrl}/upload/v1/file/create`),
            method: 'POST',
          }),
        })
      }

      return String(createdFile.fileID)
    }

    if (!createdFile.preuploadID || !createdFile.sliceSize) {
      throw createNetdiskProviderError({
        providerName,
        stage: 'upload',
        asset: request.asset,
        error: '123Pan did not return preuploadID/sliceSize for a non-reused upload.',
        diagnostics: buildDiagnostics({
          detailLevel: errorDetailLevel,
          url: new URL(`${apiBaseUrl}/upload/v1/file/create`),
          method: 'POST',
        }),
      })
    }

    const handle = await open(request.file.filePath, 'r')

    try {
      for (
        let sliceNo = 1, offset = 0;
        offset < request.file.byteSize;
        sliceNo += 1, offset += createdFile.sliceSize
      ) {
        const expectedLength = Math.min(
          createdFile.sliceSize,
          request.file.byteSize - offset,
        )
        const chunk = Buffer.allocUnsafe(expectedLength)
        const { bytesRead } = await handle.read(chunk, 0, expectedLength, offset)

        await retryStageOperation('upload', async (retry) => {
          const uploadUrl = await requestJson<Pan123UploadUrlResponse>(
            '/upload/v1/file/get_upload_url',
            {
              preuploadID: createdFile.preuploadID,
              sliceNo,
            },
            request,
            'upload',
            token,
            'POST',
            retry,
            uploadLogContext,
          )

          let response: Response
          const uploadUrlObject = new URL(uploadUrl.presignedURL)
          try {
            response = await fetcher(uploadUrl.presignedURL, {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/octet-stream',
              },
              body: chunk.subarray(0, bytesRead),
              signal: request.signal,
            })
          } catch (error) {
            appendRecentUploadLog(uploadLogContext, {
              occurredAt: now().toISOString(),
              attempt: retry?.attempts,
              message: error instanceof Error ? error.message : String(error),
            })
            throw createNetdiskProviderError({
              providerName,
              stage: 'upload',
              asset: request.asset,
              error,
              diagnostics: buildDiagnostics({
                detailLevel: errorDetailLevel,
                url: uploadUrlObject,
                method: 'PUT',
                transport: {
                  type: 'network',
                  message: error instanceof Error ? error.message : String(error),
                  causes: collectErrorCauses(error),
                },
                retry: buildRetryDiagnostics(retry, uploadLogContext),
              }),
            })
          }

          if (!response.ok) {
            const responseText = await response.text()
            appendRecentUploadLog(uploadLogContext, {
              occurredAt: now().toISOString(),
              attempt: retry?.attempts,
              httpStatus: response.status,
              statusText: response.statusText,
              message: `123Pan PUT upload failed with ${response.status} ${response.statusText}.`,
            })
            throw createNetdiskProviderError({
              providerName,
              stage: 'upload',
              asset: request.asset,
              error: `123Pan PUT upload failed with ${response.status} ${response.statusText}.`,
              diagnostics: buildDiagnostics({
                detailLevel: errorDetailLevel,
                url: uploadUrlObject,
                method: 'PUT',
                response,
                responseBody: responseText,
                retry: buildRetryDiagnostics(retry, uploadLogContext),
              }),
            })
          }
        })

        updateUploadProgress(uploadLogContext, offset + bytesRead)
      }
    } finally {
      await handle.close()
    }

    const completedUpload = await requestJson<Pan123UploadCompleteResponse>(
      '/upload/v1/file/upload_complete',
      { preuploadID: createdFile.preuploadID },
      request,
      'upload',
      token,
      'POST',
      undefined,
      uploadLogContext,
    )

    if (completedUpload.completed && completedUpload.fileID) {
      return String(completedUpload.fileID)
    }

    if (!completedUpload.async) {
      appendRecentUploadLog(uploadLogContext, {
        occurredAt: now().toISOString(),
        message: '123Pan upload did not complete and did not request async polling.',
      })
      throw createNetdiskProviderError({
        providerName,
        stage: 'upload',
        asset: request.asset,
        error: '123Pan upload did not complete and did not request async polling.',
        diagnostics: buildDiagnostics({
          detailLevel: errorDetailLevel,
          url: new URL(`${apiBaseUrl}/upload/v1/file/upload_complete`),
          method: 'POST',
          retry: buildRetryDiagnostics(undefined, uploadLogContext),
        }),
      })
    }

    for (let attempt = 0; attempt < maxUploadStatusPolls; attempt += 1) {
      await sleep(uploadPollIntervalMs)
      const uploadResult = await requestJson<Pan123UploadAsyncResultResponse>(
        '/upload/v1/file/upload_async_result',
        { preuploadID: createdFile.preuploadID },
        request,
        'upload',
        token,
        'POST',
        {
          attempts: attempt + 1,
          maxAttempts: maxUploadStatusPolls,
          intervalMs: uploadPollIntervalMs,
        },
        uploadLogContext,
      )

      if (uploadResult.completed && uploadResult.fileID) {
        return String(uploadResult.fileID)
      }

      appendRecentUploadLog(uploadLogContext, {
        occurredAt: now().toISOString(),
        attempt: attempt + 1,
        message: 'Upload is still processing.',
      })
    }

    throw createNetdiskProviderError({
      providerName,
      stage: 'upload',
      asset: request.asset,
      error: `123Pan upload polling timed out after ${maxUploadStatusPolls} attempts.`,
      diagnostics: buildDiagnostics({
        detailLevel: errorDetailLevel,
        url: new URL(`${apiBaseUrl}/upload/v1/file/upload_async_result`),
        method: 'POST',
        retry: buildRetryDiagnostics(
          {
            attempts: maxUploadStatusPolls,
            maxAttempts: maxUploadStatusPolls,
            intervalMs: uploadPollIntervalMs,
          },
          uploadLogContext,
        ),
      }),
    })
  }

  async function createShareUrl(
    token: string,
    request: NetdiskUploadRequest,
    remoteFileId: string,
  ) {
    const createdShare = await requestJson<Pan123CreateShareResponse>(
      '/api/v1/share/create',
      {
        shareName: request.asset.assetName,
        shareExpire: permanentShareExpireDays,
        fileIDList: remoteFileId,
      },
      request,
      'share',
      token,
    )

    if (!createdShare.shareKey) {
      throw createNetdiskProviderError({
        providerName,
        stage: 'share',
        asset: request.asset,
        error: '123Pan did not return a shareKey for the created share link.',
        diagnostics: buildDiagnostics({
          detailLevel: errorDetailLevel,
          url: new URL(`${apiBaseUrl}/api/v1/share/create`),
          method: 'POST',
        }),
      })
    }

    return `${defaultShareBaseUrl}${createdShare.shareKey}`
  }

  async function findExistingShareUrl(token: string, request: NetdiskUploadRequest) {
    let lastShareId = 0
    let matchedShare: Pan123ShareRecord | undefined

    while (true) {
      const response = await requestJson<Pan123ShareListResponse>(
        '/api/v1/share/list',
        {
          limit: 100,
          lastShareId,
        },
        request,
        'share',
        token,
        'GET',
      )

      for (const share of response.shareList ?? []) {
        if (
          share.shareName === request.asset.assetName &&
          share.expired === 0 &&
          share.shareKey &&
          (!matchedShare || (share.shareId ?? -1) > (matchedShare.shareId ?? -1))
        ) {
          matchedShare = share
        }
      }

      if (response.lastShareId == null || response.lastShareId === -1) {
        break
      }

      lastShareId = response.lastShareId
    }

    return matchedShare?.shareKey
      ? `${defaultShareBaseUrl}${matchedShare.shareKey}`
      : null
  }

  async function resolveDuplicateFileUpload(
    token: string,
    request: NetdiskUploadRequest,
    parentDirectoryId: Pan123FileId,
    error: unknown,
  ) {
    if (!isDuplicateFileNameError(error)) {
      throw error
    }

    const entries = await listDirectory(token, request, parentDirectoryId)
    const existingFile = entries.find(
      (entry) =>
        entry.type !== 1 &&
        entry.filename === request.asset.assetName &&
        (entry.size == null || entry.size === request.file.byteSize),
    )

    if (!existingFile?.fileId) {
      throw error
    }

    const remoteFileId = String(existingFile.fileId)
    const shareUrl =
      (await findExistingShareUrl(token, request)) ??
      (await createShareUrl(token, request, remoteFileId))

    return {
      providerName,
      remoteFileId,
      shareUrl,
      uploadedAt: now().toISOString(),
    }
  }

  return {
    providerName,
    async uploadAsset(request) {
      const targetDirectory = normalizeTargetDirectory(
        request.destination.targetDirectory,
      )

      if (!targetDirectory) {
        throw createNetdiskProviderError({
          providerName,
          stage: 'configuration',
          asset: request.asset,
          error: 'A targetDirectory is required for 123Pan uploads.',
        })
      }

      const token = await getAccessToken(request)
      const parentDirectoryId = await ensureDirectory(token, request, targetDirectory)

      let remoteFileId: string
      try {
        remoteFileId = await uploadFileParts(token, request, parentDirectoryId)
      } catch (error) {
        return resolveDuplicateFileUpload(token, request, parentDirectoryId, error)
      }

      const shareUrl = await createShareUrl(token, request, remoteFileId)

      return {
        providerName,
        remoteFileId,
        shareUrl,
        uploadedAt: now().toISOString(),
      }
    },
  }
}

export const createPan123NetdiskProvider = createPan123Provider
