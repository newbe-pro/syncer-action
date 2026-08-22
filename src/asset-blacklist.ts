import path from 'node:path'

export const defaultAssetBlacklistPatterns = ['*.yaml', '*.yml'] as const

function normalizeAssetPath(assetPath: string) {
  return assetPath.replaceAll('\\', '/').replace(/^\/+/, '')
}

export function assetBasename(assetPath: string) {
  return path.posix.basename(normalizeAssetPath(assetPath))
}

function escapeForRegularExpression(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

export function createCaseInsensitiveGlobRegExp(pattern: string) {
  let regularExpression = '^'

  for (const character of pattern) {
    if (character === '*') {
      regularExpression += '.*'
    } else if (character === '?') {
      regularExpression += '.'
    } else {
      regularExpression += escapeForRegularExpression(character)
    }
  }

  return new RegExp(`${regularExpression}$`, 'i')
}

export function validateAssetBlacklistPattern(pattern: string) {
  try {
    createCaseInsensitiveGlobRegExp(pattern)
    return true
  } catch {
    return false
  }
}

export function findMatchingAssetBlacklistPattern(
  assetPath: string,
  patterns: readonly string[] | undefined,
) {
  const name = assetBasename(assetPath)
  return patterns?.find((pattern) => createCaseInsensitiveGlobRegExp(pattern).test(name))
}
