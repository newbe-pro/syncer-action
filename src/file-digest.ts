import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { type LocalFileMetadata } from './release-sync-contracts'

export async function describeLocalFile(filePath: string): Promise<LocalFileMetadata> {
  const metadata = await stat(filePath)
  const sha256 = createHash('sha256')
  const md5 = createHash('md5')

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => {
      sha256.update(chunk)
      md5.update(chunk)
    })
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })

  return {
    filePath,
    byteSize: metadata.size,
    sha256: sha256.digest('hex'),
    md5: md5.digest('hex'),
  }
}
