import { describe, expect, it } from 'vitest'
import { findMatchingAssetBlacklistPattern } from '../src/asset-blacklist'

describe('findMatchingAssetBlacklistPattern', () => {
  it.each([
    ['config.yaml', '*.yaml'],
    ['deploy.yml', '*.yml'],
    ['CONFIG.YAML', '*.yaml'],
    ['nested/path/deploy.YmL', '*.yml'],
    ['config.json', undefined],
    ['yaml-notes.txt', undefined],
  ])('matches %s as expected', (assetName, expected) => {
    expect(findMatchingAssetBlacklistPattern(assetName, ['*.yaml', '*.yml'])).toBe(expected)
  })

  it('normalizes Windows separators and matches the basename', () => {
    expect(findMatchingAssetBlacklistPattern('nested\\config.yaml', ['*.yaml'])).toBe('*.yaml')
    expect(findMatchingAssetBlacklistPattern('nested/config.json', ['*.yaml'])).toBeUndefined()
  })
})
