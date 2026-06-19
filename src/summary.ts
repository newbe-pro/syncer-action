import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type ReleaseSyncJobResult,
  type ReleaseSyncRunSummary,
  type WorkflowRunConclusion,
} from './release-sync-contracts'

export function determineWorkflowRunConclusion(
  summary: ReleaseSyncRunSummary,
): WorkflowRunConclusion {
  const hasFailures = summary.failedCount > 0 || Boolean(summary.metadataPublicationFailure)
  if (hasFailures) {
    return summary.syncedCount > 0 || summary.skippedCount > 0
      ? 'partial_failure'
      : 'failure'
  }

  if (summary.syncedCount === 0) {
    return 'noop'
  }

  return 'success'
}

export function createJobResult(input: {
  repositoryKey: string
  targetName: string
  summary: ReleaseSyncRunSummary
}) {
  return {
    repositoryKey: input.repositoryKey,
    targetName: input.targetName,
    providerName: input.summary.providerName,
    conclusion: determineWorkflowRunConclusion(input.summary),
    summary: input.summary,
    generatedAt: new Date().toISOString(),
  } satisfies ReleaseSyncJobResult
}

export function sanitizeArtifactName(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'result'
}

export async function writeResultFile(resultPath: string, result: ReleaseSyncJobResult) {
  await mkdir(path.dirname(resultPath), { recursive: true })
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

async function listJsonFiles(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }

  const results: string[] = []
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      results.push(...(await listJsonFiles(entryPath)))
      continue
    }

    if (entry.isFile() && entry.name.endsWith('.json')) {
      results.push(entryPath)
    }
  }

  return results.sort((left, right) => left.localeCompare(right))
}

export async function readResultFiles(resultsDirectory: string) {
  const files = await listJsonFiles(resultsDirectory)
  const results = await Promise.all(
    files.map(async (filePath) => JSON.parse(await readFile(filePath, 'utf8')) as ReleaseSyncJobResult),
  )

  return { files, results }
}

function priorityForConclusion(conclusion: WorkflowRunConclusion) {
  switch (conclusion) {
    case 'failure':
      return 3
    case 'partial_failure':
      return 2
    case 'success':
      return 1
    case 'noop':
    default:
      return 0
  }
}

export function aggregateWorkflowRunConclusion(results: ReleaseSyncJobResult[]) {
  return results.reduce<WorkflowRunConclusion>(
    (current, result) =>
      priorityForConclusion(result.conclusion) > priorityForConclusion(current)
        ? result.conclusion
        : current,
    'noop',
  )
}

export function renderJobSummaryMarkdown(result: ReleaseSyncJobResult) {
  const { summary } = result
  const lines = [
    `## ${result.repositoryKey} -> ${result.targetName}`,
    '',
    `- Conclusion: ${result.conclusion}`,
    `- Assets: ${summary.discoveredAssetCount} discovered, ${summary.syncedCount} synced, ${summary.skippedCount} skipped, ${summary.failedCount} failed`,
  ]

  if (summary.metadataPublicationFailure) {
    lines.push(
      `- Metadata publication: ${summary.metadataPublicationFailure.message}`,
    )
  }

  if (summary.failures.length > 0) {
    lines.push('', '### Failures')
    for (const failure of summary.failures.slice(0, 10)) {
      const stageSegment = failure.failureStage ? ` (${failure.failureStage})` : ''
      lines.push(`- ${failure.assetName}${stageSegment}: ${failure.message}`)
    }
  }

  if (summary.repositories.some((repository) => repository.outcomes.length > 0)) {
    lines.push('', '### Outcomes')
    for (const repository of summary.repositories) {
      for (const outcome of repository.outcomes.slice(0, 20)) {
        lines.push(`- ${outcome.assetName}: ${outcome.status}`)
      }
    }
  }

  return `${lines.join('\n')}\n`
}

export function renderAggregateSummaryMarkdown(results: ReleaseSyncJobResult[]) {
  const conclusion = aggregateWorkflowRunConclusion(results)
  const totalJobs = results.length
  const totalSynced = results.reduce((total, result) => total + result.summary.syncedCount, 0)
  const totalSkipped = results.reduce((total, result) => total + result.summary.skippedCount, 0)
  const totalFailed = results.reduce((total, result) => total + result.summary.failedCount, 0)
  const metadataFailures = results.filter((result) => result.summary.metadataPublicationFailure)

  const lines = [
    '## Release Sync Overview',
    '',
    `- Conclusion: ${conclusion}`,
    `- Matrix jobs: ${totalJobs}`,
    `- Synced: ${totalSynced}`,
    `- Skipped: ${totalSkipped}`,
    `- Failed assets: ${totalFailed}`,
  ]

  if (metadataFailures.length > 0) {
    lines.push(`- Metadata publication failures: ${metadataFailures.length}`)
  }

  if (results.length > 0) {
    lines.push('', '### Jobs')
    for (const result of results) {
      lines.push(
        `- ${result.repositoryKey} -> ${result.targetName}: ${result.conclusion}`,
      )
    }
  }

  return `${lines.join('\n')}\n`
}

export async function appendGitHubStepSummary(markdown: string) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) {
    return
  }

  await mkdir(path.dirname(summaryPath), { recursive: true })
  await writeFile(summaryPath, markdown, { encoding: 'utf8', flag: 'a' })
}

export async function setGitHubOutput(name: string, value: string) {
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) {
    return
  }

  const delimiter = `SYNCER_ACTION_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
  const payload = `${name}<<${delimiter}\n${value}\n${delimiter}\n`
  await writeFile(outputPath, payload, { encoding: 'utf8', flag: 'a' })
}
