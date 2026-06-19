import path from 'node:path'
import { loadSyncerActionConfig, resolveWorkflowRunOverrides, toGitHubTargetRepository } from './config'
import { createGitHubReleaseSource } from './github-release-source'
import {
  createReleaseSyncMetadataStore,
} from './metadata/azure-manifest-store'
import { createPan123Provider } from './providers/pan123-provider'
import {
  createReleaseSyncRunner,
  formatReleaseSyncRunSummary,
} from './release-sync-runner'
import {
  aggregateWorkflowRunConclusion,
  appendGitHubStepSummary,
  createJobResult,
  readResultFiles,
  renderAggregateSummaryMarkdown,
  renderJobSummaryMarkdown,
  sanitizeArtifactName,
  setGitHubOutput,
  writeResultFile,
} from './summary'
import { buildWorkflowMatrix, findWorkflowMatrixItem } from './workflow-matrix'

function parseFlags(argv: string[]) {
  const flags = new Map<string, string>()

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) {
      continue
    }

    const [name, inlineValue] = token.slice(2).split('=', 2)
    if (inlineValue !== undefined) {
      flags.set(name, inlineValue)
      continue
    }

    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      flags.set(name, next)
      index += 1
      continue
    }

    flags.set(name, 'true')
  }

  return flags
}

async function runPlan(flags: Map<string, string>) {
  const rootDirectory = flags.get('root-directory')
  const config = loadSyncerActionConfig({ rootDirectory })
  const overrides = resolveWorkflowRunOverrides()
  const items = buildWorkflowMatrix(config, overrides)
  const matrix = JSON.stringify({ item: items })
  const markdown = [
    '## Plan',
    '',
    `- Config: ${config.configFilePath}`,
    `- Matrix jobs: ${items.length}`,
    `- Workflow max parallel: ${config.concurrency.workflowMaxParallel}`,
    `- Dry run: ${overrides.dryRun ? 'true' : 'false'}`,
  ].join('\n')

  await appendGitHubStepSummary(`${markdown}\n`)
  await setGitHubOutput('matrix', matrix)
  await setGitHubOutput('matrix_count', String(items.length))
  await setGitHubOutput('max_parallel', String(config.concurrency.workflowMaxParallel))
  await setGitHubOutput('has_work', items.length > 0 ? 'true' : 'false')
  process.stdout.write(`${matrix}\n`)
}

async function runSync(flags: Map<string, string>) {
  const rootDirectory = flags.get('root-directory')
  const config = loadSyncerActionConfig({ rootDirectory })
  const overrides = resolveWorkflowRunOverrides()
  const rawMatrixItem = flags.get('matrix-item') ?? process.env.SYNCER_ACTION_MATRIX_ITEM
  let item

  if (rawMatrixItem) {
    const parsed = JSON.parse(rawMatrixItem) as { repositoryKey: string; targetName: string }
    item = findWorkflowMatrixItem(config, parsed, overrides)
    if (!item) {
      throw new Error(
        `Unable to resolve matrix item for ${parsed.repositoryKey} -> ${parsed.targetName}.`,
      )
    }
  } else {
    const items = buildWorkflowMatrix(config, overrides)
    if (items.length !== 1) {
      throw new Error('sync requires --matrix-item when more than one matrix item exists.')
    }

    ;[item] = items
  }

  const repository = config.repositories.find(
    (candidate) => candidate.key === item.repositoryKey,
  )
  if (!repository) {
    throw new Error(`Repository ${item.repositoryKey} is not defined in ${config.configFilePath}.`)
  }

  const provider = createPan123Provider(config.providers.pan123)
  const metadataStore = createReleaseSyncMetadataStore({
    connectionString: config.azure.connectionString,
    containerName: config.azure.containerName,
    containerSasUrl: config.azure.containerSasUrl,
    prefix: config.azure.prefix,
  })
  const runner = createReleaseSyncRunner({
    source: createGitHubReleaseSource({
      repositories: [toGitHubTargetRepository(repository, item.targetDirectory)],
      token: config.github.token,
      apiBaseUrl: config.github.apiBaseUrl,
      temporaryDirectory: config.temporaryDirectory,
    }),
    provider,
    metadataStore,
    maxParallelAssets: item.maxParallelAssets,
    dryRun: item.dryRun,
  })
  const summary = await runner.run()
  const result = createJobResult({
    repositoryKey: item.repositoryKey,
    targetName: item.targetName,
    summary,
  })
  const resultPath = path.join(
    flags.get('results-dir') ?? config.resultsDirectory,
    `${sanitizeArtifactName(item.repositoryKey)}--${sanitizeArtifactName(item.targetName)}.json`,
  )

  await writeResultFile(resultPath, result)
  await appendGitHubStepSummary(renderJobSummaryMarkdown(result))
  await setGitHubOutput('result_path', resultPath)
  await setGitHubOutput('conclusion', result.conclusion)
  await setGitHubOutput('repository_key', item.repositoryKey)
  await setGitHubOutput('target_name', item.targetName)
  await setGitHubOutput('failed_count', String(summary.failedCount))
  await setGitHubOutput('metadata_prefix', config.azure.prefix)
  process.stdout.write(`${formatReleaseSyncRunSummary(summary)}\n`)

  if (result.conclusion === 'partial_failure' || result.conclusion === 'failure') {
    throw new Error(`Sync job concluded with ${result.conclusion}.`)
  }
}

async function runSummarize(flags: Map<string, string>) {
  const rootDirectory = flags.get('root-directory')
  const config = loadSyncerActionConfig({ rootDirectory })
  const resultsDirectory = flags.get('results-dir') ?? config.resultsDirectory
  const { results } = await readResultFiles(resultsDirectory)

  const conclusion = aggregateWorkflowRunConclusion(results)
  const markdown = renderAggregateSummaryMarkdown(results)

  await appendGitHubStepSummary(markdown)
  await setGitHubOutput('conclusion', conclusion)
  await setGitHubOutput('job_count', String(results.length))
  await setGitHubOutput('metadata_prefix', config.azure.prefix)
  process.stdout.write(`${conclusion}\n`)
}

async function main() {
  const [, , command = 'sync', ...rest] = process.argv
  const flags = parseFlags(rest)

  switch (command) {
    case 'plan':
      await runPlan(flags)
      return
    case 'sync':
      await runSync(flags)
      return
    case 'summarize':
      await runSummarize(flags)
      return
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exitCode = 1
})
