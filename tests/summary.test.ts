import { describe, expect, it } from 'vitest'
import { determineWorkflowRunConclusion } from '../src/summary'
import type { ReleaseSyncRunSummary } from '../src/release-sync-contracts'

function createSummary(overrides: Partial<ReleaseSyncRunSummary> = {}): ReleaseSyncRunSummary {
  return {
    startedAt: '2026-06-19T00:00:00.000Z',
    finishedAt: '2026-06-19T00:01:00.000Z',
    providerName: '123pan',
    repositoryCount: 1,
    discoveredAssetCount: 1,
    processedAssetCount: 1,
    syncedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    repositories: [],
    failures: [],
    metadataPublicationFailure: null,
    ...overrides,
  }
}

describe('determineWorkflowRunConclusion', () => {
  it('returns noop when nothing changed', () => {
    expect(
      determineWorkflowRunConclusion(
        createSummary({ discoveredAssetCount: 0, processedAssetCount: 0 }),
      ),
    ).toBe('noop')
  })

  it('returns success when at least one asset synced', () => {
    expect(determineWorkflowRunConclusion(createSummary({ syncedCount: 1 }))).toBe('success')
  })

  it('returns partial_failure when sync failures or metadata drift exist alongside work', () => {
    expect(
      determineWorkflowRunConclusion(
        createSummary({
          syncedCount: 1,
          metadataPublicationFailure: {
            repositoryKey: 'openai/codex',
            message: 'index refresh failed',
            manifestPath: 'release-sync/openai/codex/v1.0.0/manifest.json',
            rootIndexPath: 'release-sync/index.json',
            manifestPersisted: true,
            occurredAt: '2026-06-19T00:01:00.000Z',
          },
        }),
      ),
    ).toBe('partial_failure')
  })

  it('returns failure when the run has only failures', () => {
    expect(determineWorkflowRunConclusion(createSummary({ failedCount: 1 }))).toBe('failure')
  })
})
