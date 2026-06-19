# syncer-action

`syncer-action` runs GitHub Release to 123Pan synchronization directly inside GitHub Actions. The repository list and sync behavior are stored in-repo as YAML, while release metadata stays in Azure Blob Storage so other applications can continue reading the same `manifest.json` and `index.json` contract.

## Required Secrets

123Pan:

- `NETDISK_123PAN_CLIENT_ID`
- `NETDISK_123PAN_CLIENT_SECRET`

Azure metadata, choose one mode:

- Recommended: `AZURE_STORAGE_BLOB_SAS_URL`
- Or: `AZURE_STORAGE_CONNECTION_STRING` and `AZURE_STORAGE_CONTAINER`

GitHub:

- `GITHUB_TOKEN` is provided automatically in Actions as `${{ github.token }}`

## Config File

The sync target list is stored directly in this repo at `syncer-action.config.yml`. Adding or removing synchronized repositories only requires editing that YAML file; the workflow file does not need per-repository changes.

You can start from [syncer-action.config.example.yml](./syncer-action.config.example.yml). JSON is still accepted as a compatibility fallback, but YAML is the default.

```yaml
azure:
  prefix: release-sync

concurrency:
  workflowMaxParallel: 2
  maxParallelAssets: 2

repositories:
  - owner: microsoft
    repo: PowerToys
    assetExcludePatterns:
      - "*symbols*"
    targets:
      - name: 123pan
        provider: 123pan
        targetDirectory: /syncer/powertoys

  - owner: PowerShell
    repo: PowerShell
    targets:
      - name: 123pan
        provider: 123pan
        targetDirectory: /syncer/powershell
```

`targetDirectory` is the remote base directory. The runner appends the current `releaseTagName`, so `/syncer/powertoys` becomes `/syncer/powertoys/v0.90.0` during upload.

## Azure Metadata Paths

- Release manifests: `<prefix>/<owner>/<repo>/<releaseTagName>/manifest.json`
- Root index: `<prefix>/index.json`

These JSON documents are written to Azure Blob Storage, not committed back to the repository.

## Workflow Usage

The repository workflow lives at [release-sync.yml](./.github/workflows/release-sync.yml).

- Scheduled runs use the built-in `schedule` trigger.
- Manual runs use `workflow_dispatch` with optional repository, target, and `dry_run` overrides.
- Matrix jobs are generated from `syncer-action.config.yml`, one repository-target pair per job.
- Each sync job writes a GitHub Actions summary and a machine-readable JSON result artifact.
- The summarize job aggregates results, uploads a final summary bundle artifact, and records the workflow conclusion.
- A separate conclude job fails the workflow after summary/upload complete when the final conclusion is `partial_failure` or `failure`.

Manual run examples:

- Sync every configured repository: leave inputs empty.
- Sync only one repository: set `repositories` to `openai/codex`.
- Sync one repository-target pair: set `repositories` to `openai/codex` and `targets` to `123pan`.
- Validate planning without uploads or Azure writes: set `dry_run` to `true`.

## Local Commands

```bash
npm ci
npm run plan
npm run sync -- --matrix-item '{"repositoryKey":"openai/codex","targetName":"123pan"}'
npm test
npm run typecheck
```

## Troubleshooting

- Missing Azure credentials: the config loader fails fast when repositories are configured but neither `AZURE_STORAGE_BLOB_SAS_URL` nor connection-string mode is available.
- Missing Azure container name: `AZURE_STORAGE_CONTAINER` is required when using `AZURE_STORAGE_CONNECTION_STRING`.
- No-op runs: expected when the latest release has no eligible assets or all assets already match manifest evidence.
- Metadata publication drift: if `manifest.json` was written but `index.json` refresh failed, the job reports an explicit metadata publication error with both blob paths.
- 123Pan target-directory issues: the provider creates missing directories segment by segment; duplicate-name or permission failures are surfaced with structured stage diagnostics.
