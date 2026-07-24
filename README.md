# syncer-action

`syncer-action` runs GitHub Release to 123Pan synchronization directly inside GitHub Actions. The repository list and sync behavior are stored in-repo as YAML, while release metadata is stored as assets on this repository's latest **draft (drafter) release** so other applications can continue reading the same `manifest.json` and `index.json` contract.

## Required Secrets

123Pan:

- `NETDISK_123PAN_CLIENT_ID`
- `NETDISK_123PAN_CLIENT_SECRET`

GitHub:

- `GITHUB_TOKEN` is provided automatically in Actions as `${{ github.token }}`
- The workflow needs `contents: write` so metadata assets can be uploaded to the draft release

## Config File

The sync target list is stored directly in this repo at `syncer-action.config.yml`. Adding or removing synchronized repositories only requires editing that YAML file; the workflow file does not need per-repository changes.

You can start from [syncer-action.config.example.yml](./syncer-action.config.example.yml). JSON is still accepted as a compatibility fallback, but YAML is the default.

```yaml
metadataStorage:
  prefix: release-sync
  releaseSelector: latest-draft
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

`metadataStorage.owner` / `metadataStorage.repo` default to `GITHUB_REPOSITORY` (the Action repository). `prefix` defaults to `release-sync`. `releaseSelector` currently only supports `latest-draft`.

`targetDirectory` is the remote base directory. The runner appends the current `releaseTagName`, so `/syncer/powertoys` becomes `/syncer/powertoys/v0.90.0` during upload.

## Draft Release Metadata Paths

Logical storage paths (serialized as `blobPath` in JSON; not Azure Blob paths):

- Release manifests: `<prefix>/<owner>/<repo>/<releaseTagName>/manifest.json`
- Root index: `<prefix>/index.json`

Because GitHub release assets are a flat file list, each logical path is stored as a single asset name with `/` replaced by `__` (for example `release-sync__index.json`).

These JSON documents are written to the latest draft release assets, not committed back to the repository. A draft release must already exist (for example via release-drafter).

## Workflow Usage

Dispatch `Release Sync` from the Actions tab:

1. Leave `repositories` empty to sync every repository listed in the config file.
2. Provide a subset such as `microsoft/PowerToys,PowerShell/PowerShell` when you only want selected repositories.
3. Set `dry_run=true` to resolve the matrix and plan without uploading to 123Pan or rewriting draft-release metadata.

## Local Commands

```bash
npm install
npm run plan
npm run sync -- --matrix-item '{"repositoryKey":"microsoft/PowerToys","targetName":"123pan"}'
npm run summarize
npm test
```

Environment variables for local runs:

- `GITHUB_TOKEN`
- `NETDISK_123PAN_CLIENT_ID`
- `NETDISK_123PAN_CLIENT_SECRET`
- `GITHUB_REPOSITORY` (optional override for metadata storage owner/repo when not set in config)
