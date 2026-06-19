import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { type NetdiskErrorDetailLevel } from './release-sync-contracts'

const githubRepositoryKeyPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export interface GitHubTargetRepository {
  key: string
  owner: string
  repo: string
  targetDirectory?: string
  assetExcludePatterns?: string[]
}

export interface SyncerActionTarget {
  name: string
  provider: '123pan'
  targetDirectory: string
  maxParallelAssets: number
}

export interface SyncerActionRepository {
  key: string
  owner: string
  repo: string
  assetExcludePatterns: string[]
  targets: SyncerActionTarget[]
}

export interface WorkflowRunOverrides {
  repositoryKeys?: string[]
  targetNames?: string[]
  dryRun: boolean
}

export interface SyncerActionConfig {
  rootDirectory: string
  configFilePath: string
  temporaryDirectory: string
  resultsDirectory: string
  github: {
    token?: string
    apiBaseUrl: string
  }
  azure: {
    connectionString?: string
    containerName?: string
    containerSasUrl?: string
    prefix: string
  }
  concurrency: {
    workflowMaxParallel: number
    maxParallelAssets: number
  }
  providers: {
    pan123: {
      clientId: string
      clientSecret: string
      tokenCachePath: string
      apiBaseUrl?: string
      errorDetailLevel: NetdiskErrorDetailLevel
    }
  }
  repositories: SyncerActionRepository[]
  requiredSecrets: string[]
}

const targetSchema = z.object({
  name: z.string().trim().min(1).default('123pan'),
  provider: z.literal('123pan').default('123pan'),
  targetDirectory: z.string().trim().min(1),
  maxParallelAssets: z.number().int().positive().optional(),
})

const repositorySchema = z.object({
  owner: z.string().trim().min(1),
  repo: z.string().trim().min(1),
  assetExcludePatterns: z.array(z.string().trim().min(1)).default([]),
  targetDirectory: z.string().trim().min(1).optional(),
  targets: z.array(targetSchema).optional(),
})

const configSchema = z.object({
  github: z
    .object({
      apiBaseUrl: z.string().trim().url().optional(),
    })
    .default({}),
  azure: z
    .object({
      prefix: z.string().trim().min(1).default('release-sync'),
    })
    .default({ prefix: 'release-sync' }),
  concurrency: z
    .object({
      workflowMaxParallel: z.number().int().positive().default(2),
      maxParallelAssets: z.number().int().positive().default(2),
    })
    .default({ workflowMaxParallel: 2, maxParallelAssets: 2 }),
  providers: z
    .object({
      pan123: z
        .object({
          apiBaseUrl: z.string().trim().url().optional(),
          errorDetailLevel: z.enum(['diagnostic', 'summary']).default('diagnostic'),
        })
        .default({ errorDetailLevel: 'diagnostic' }),
    })
    .default({ pan123: { errorDetailLevel: 'diagnostic' } }),
  repositories: z.array(repositorySchema).default([]),
})

function normalizeOptionalString(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function normalizeBooleanFlag(value: string | undefined) {
  const normalized = normalizeOptionalString(value)?.toLowerCase()
  if (!normalized) {
    return false
  }

  return ['1', 'true', 'yes', 'on'].includes(normalized)
}

function normalizeTargetDirectory(value: string) {
  const parts = value
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)

  return parts.length === 0 ? '/' : `/${parts.join('/')}`
}

function normalizeListInput(value: string | undefined) {
  const normalized = normalizeOptionalString(value)
  if (!normalized) {
    return undefined
  }

  try {
    const parsed = JSON.parse(normalized) as unknown
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) {
      return parsed.map((entry) => entry.trim()).filter(Boolean)
    }
  } catch {
    // Fall back to comma/newline parsing.
  }

  return normalized
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function resolveConfigFilePath(rootDirectory: string, source: Record<string, string | undefined>) {
  const configuredPath = normalizeOptionalString(source.SYNCER_ACTION_CONFIG_FILE)
  if (configuredPath) {
    return path.isAbsolute(configuredPath)
      ? path.resolve(configuredPath)
      : path.resolve(rootDirectory, configuredPath)
  }

  const defaultCandidates = [
    'syncer-action.config.yml',
    'syncer-action.config.yaml',
    'syncer-action.config.json',
  ].map((candidate) => path.resolve(rootDirectory, candidate))

  return defaultCandidates.find((candidate) => existsSync(candidate)) ?? defaultCandidates[0]!
}

function parseConfigFileContents(configFilePath: string, contents: string) {
  const extension = path.extname(configFilePath).toLowerCase()

  if (extension === '.yaml' || extension === '.yml') {
    return parseYaml(contents)
  }

  return JSON.parse(contents)
}

function parseConfigFile(configFilePath: string) {
  if (!existsSync(configFilePath)) {
    throw new Error(
      `Config file not found at ${configFilePath}. Create syncer-action.config.yml or set SYNCER_ACTION_CONFIG_FILE.`,
    )
  }

  try {
    return configSchema.parse(
      parseConfigFileContents(configFilePath, readFileSync(configFilePath, 'utf8')),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown config parsing error.'
    throw new Error(`Failed to parse syncer-action config at ${configFilePath}: ${message}`)
  }
}

function createRepositoryKey(owner: string, repo: string) {
  const key = `${owner}/${repo}`
  if (!githubRepositoryKeyPattern.test(key)) {
    throw new Error(`Invalid GitHub repository key "${key}". Expected owner/repo.`)
  }

  return key
}

function normalizeRepositories(parsedConfig: z.infer<typeof configSchema>) {
  return parsedConfig.repositories.map<SyncerActionRepository>((repository) => {
    const key = createRepositoryKey(repository.owner, repository.repo)
    const targets =
      repository.targets && repository.targets.length > 0
        ? repository.targets
        : repository.targetDirectory
          ? [
              {
                name: '123pan',
                provider: '123pan' as const,
                targetDirectory: repository.targetDirectory,
              },
            ]
          : []

    if (targets.length === 0) {
      throw new Error(`Repository ${key} must define targets or targetDirectory.`)
    }

    return {
      key,
      owner: repository.owner,
      repo: repository.repo,
      assetExcludePatterns: repository.assetExcludePatterns,
      targets: targets.map((target) => ({
        name: target.name,
        provider: target.provider,
        targetDirectory: normalizeTargetDirectory(target.targetDirectory),
        maxParallelAssets:
          target.maxParallelAssets ?? parsedConfig.concurrency.maxParallelAssets,
      })),
    }
  })
}

function validateRequiredSecrets(input: {
  repositories: SyncerActionRepository[]
  source: Record<string, string | undefined>
  rootDirectory: string
  pan123ErrorDetailLevel: NetdiskErrorDetailLevel
  pan123ApiBaseUrl?: string
  azurePrefix: string
  githubApiBaseUrl: string
  workflowMaxParallel: number
  maxParallelAssets: number
  configFilePath: string
}) {
  const source = input.source
  const requiredSecrets: string[] = []
  const hasRepositories = input.repositories.length > 0

  const needsPan123 = input.repositories.some((repository) =>
    repository.targets.some((target) => target.provider === '123pan'),
  )
  const azureContainerSasUrl = normalizeOptionalString(source.AZURE_STORAGE_BLOB_SAS_URL)
  const azureConnectionString = normalizeOptionalString(source.AZURE_STORAGE_CONNECTION_STRING)
  const azureContainerName = normalizeOptionalString(source.AZURE_STORAGE_CONTAINER)
  const pan123ClientId = normalizeOptionalString(source.NETDISK_123PAN_CLIENT_ID)
  const pan123ClientSecret = normalizeOptionalString(source.NETDISK_123PAN_CLIENT_SECRET)
  const pan123TokenCachePath = path.resolve(
    input.rootDirectory,
    normalizeOptionalString(source.NETDISK_123PAN_TOKEN_CACHE_PATH) ?? '.runtime/123pan-access-token.json',
  )

  if (needsPan123 && (!pan123ClientId || !pan123ClientSecret)) {
    const missing = [
      !pan123ClientId ? 'NETDISK_123PAN_CLIENT_ID' : null,
      !pan123ClientSecret ? 'NETDISK_123PAN_CLIENT_SECRET' : null,
    ]
      .filter(Boolean)
      .join(', ')
    throw new Error(`123Pan targets require ${missing}.`)
  }

  if (needsPan123) {
    requiredSecrets.push('NETDISK_123PAN_CLIENT_ID', 'NETDISK_123PAN_CLIENT_SECRET')
  }

  if (hasRepositories && !azureContainerSasUrl && !azureConnectionString) {
    throw new Error(
      'AZURE_STORAGE_BLOB_SAS_URL or AZURE_STORAGE_CONNECTION_STRING is required when repositories are configured.',
    )
  }

  if (azureConnectionString && !azureContainerName) {
    throw new Error(
      'AZURE_STORAGE_CONTAINER is required when AZURE_STORAGE_CONNECTION_STRING is configured.',
    )
  }

  if (azureContainerSasUrl) {
    requiredSecrets.push('AZURE_STORAGE_BLOB_SAS_URL')
  } else if (azureConnectionString) {
    requiredSecrets.push('AZURE_STORAGE_CONNECTION_STRING', 'AZURE_STORAGE_CONTAINER')
  }

  return {
    requiredSecrets,
    config: {
      rootDirectory: input.rootDirectory,
      configFilePath: input.configFilePath,
      temporaryDirectory: path.resolve(
        input.rootDirectory,
        normalizeOptionalString(source.SYNCER_ACTION_TEMP_DIRECTORY) ?? '.runtime/release-downloads',
      ),
      resultsDirectory: path.resolve(
        input.rootDirectory,
        normalizeOptionalString(source.SYNCER_ACTION_RESULTS_DIR) ?? '.runtime/results',
      ),
      github: {
        token: normalizeOptionalString(source.GITHUB_TOKEN),
        apiBaseUrl: input.githubApiBaseUrl,
      },
      azure: {
        connectionString: azureConnectionString,
        containerName: azureContainerName,
        containerSasUrl: azureContainerSasUrl,
        prefix: input.azurePrefix,
      },
      concurrency: {
        workflowMaxParallel: input.workflowMaxParallel,
        maxParallelAssets: input.maxParallelAssets,
      },
      providers: {
        pan123: {
          clientId: pan123ClientId ?? '',
          clientSecret: pan123ClientSecret ?? '',
          tokenCachePath: pan123TokenCachePath,
          apiBaseUrl: input.pan123ApiBaseUrl,
          errorDetailLevel: input.pan123ErrorDetailLevel,
        },
      },
      repositories: input.repositories,
      requiredSecrets,
    } satisfies SyncerActionConfig,
  }
}

export function resolveWorkflowRunOverrides(source: Record<string, string | undefined> = process.env) {
  return {
    repositoryKeys:
      normalizeListInput(source.SYNCER_ACTION_REPOSITORIES ?? source.INPUT_REPOSITORIES) ??
      undefined,
    targetNames:
      normalizeListInput(source.SYNCER_ACTION_TARGETS ?? source.INPUT_TARGETS) ?? undefined,
    dryRun: normalizeBooleanFlag(source.SYNCER_ACTION_DRY_RUN ?? source.INPUT_DRY_RUN),
  } satisfies WorkflowRunOverrides
}

export function loadSyncerActionConfig(options?: {
  rootDirectory?: string
  source?: Record<string, string | undefined>
}) {
  const rootDirectory = path.resolve(options?.rootDirectory ?? process.cwd())
  const source = options?.source ?? process.env
  const configFilePath = resolveConfigFilePath(rootDirectory, source)
  const parsedConfig = parseConfigFile(configFilePath)
  const repositories = normalizeRepositories(parsedConfig)

  return validateRequiredSecrets({
    repositories,
    source,
    rootDirectory,
    pan123ErrorDetailLevel: parsedConfig.providers.pan123.errorDetailLevel,
    pan123ApiBaseUrl: parsedConfig.providers.pan123.apiBaseUrl,
    azurePrefix: parsedConfig.azure.prefix,
    githubApiBaseUrl: parsedConfig.github.apiBaseUrl ?? 'https://api.github.com',
    workflowMaxParallel: parsedConfig.concurrency.workflowMaxParallel,
    maxParallelAssets: parsedConfig.concurrency.maxParallelAssets,
    configFilePath,
  }).config
}

export function toGitHubTargetRepository(
  repository: SyncerActionRepository,
  targetDirectory?: string,
): GitHubTargetRepository {
  return {
    key: repository.key,
    owner: repository.owner,
    repo: repository.repo,
    targetDirectory,
    assetExcludePatterns:
      repository.assetExcludePatterns.length > 0 ? repository.assetExcludePatterns : undefined,
  }
}
