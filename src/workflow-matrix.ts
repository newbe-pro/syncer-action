import {
  type SyncerActionConfig,
  type WorkflowRunOverrides,
} from './config'

export interface WorkflowMatrixItem {
  repositoryKey: string
  owner: string
  repo: string
  targetName: string
  providerName: '123pan'
  targetDirectory: string
  assetExcludePatterns: string[]
  maxParallelAssets: number
  dryRun: boolean
}

function matchesRepositoryFilter(
  repositoryKey: string,
  repositoryKeys: string[] | undefined,
) {
  return !repositoryKeys || repositoryKeys.length === 0 || repositoryKeys.includes(repositoryKey)
}

function matchesTargetFilter(targetName: string, targetNames: string[] | undefined) {
  return !targetNames || targetNames.length === 0 || targetNames.includes(targetName)
}

export function buildWorkflowMatrix(
  config: SyncerActionConfig,
  overrides: WorkflowRunOverrides,
): WorkflowMatrixItem[] {
  return config.repositories
    .filter((repository) => matchesRepositoryFilter(repository.key, overrides.repositoryKeys))
    .flatMap((repository) =>
      repository.targets
        .filter((target) => matchesTargetFilter(target.name, overrides.targetNames))
        .map<WorkflowMatrixItem>((target) => ({
          repositoryKey: repository.key,
          owner: repository.owner,
          repo: repository.repo,
          targetName: target.name,
          providerName: target.provider,
          targetDirectory: target.targetDirectory,
          assetExcludePatterns: repository.assetExcludePatterns,
          maxParallelAssets: target.maxParallelAssets,
          dryRun: overrides.dryRun,
        })),
    )
    .sort(
      (left, right) =>
        left.repositoryKey.localeCompare(right.repositoryKey) ||
        left.targetName.localeCompare(right.targetName),
    )
}

export function findWorkflowMatrixItem(
  config: SyncerActionConfig,
  input: Pick<WorkflowMatrixItem, 'repositoryKey' | 'targetName'>,
  overrides: WorkflowRunOverrides,
) {
  return buildWorkflowMatrix(config, overrides).find(
    (item) =>
      item.repositoryKey === input.repositoryKey && item.targetName === input.targetName,
  )
}
