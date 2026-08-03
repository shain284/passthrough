import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Picks a name that does not already exist, so re-rendering the same file with
 * different settings never silently destroys the previous result.
 */
export async function uniqueOutputPath(
  dir: string,
  base: string,
  suffix: string,
  ext: string
): Promise<string> {
  const stem = `${base} ${suffix}`
  for (let n = 0; n < 500; n++) {
    const name = n === 0 ? `${stem}${ext}` : `${stem} ${n + 1}${ext}`
    const candidate = path.join(dir, name)
    try {
      await fsp.access(candidate)
    } catch {
      return candidate
    }
  }
  return path.join(dir, `${stem} ${randomUUID().slice(0, 8)}${ext}`)
}
