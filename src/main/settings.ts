import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Settings } from '@shared/types'

let cached: Settings | null = null

function file(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function defaults(): Settings {
  let dir: string
  try {
    dir = app.getPath('downloads')
  } catch {
    dir = app.getPath('home')
  }
  return { outputDir: dir, useCookies: false }
}

export function getSettings(): Settings {
  if (cached) return cached
  const base = defaults()
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Settings>
    cached = {
      outputDir:
        typeof raw.outputDir === 'string' && raw.outputDir ? raw.outputDir : base.outputDir,
      useCookies: raw.useCookies === true
    }
  } catch {
    cached = base
  }
  return cached
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings(), ...patch }
  cached = next
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    // Settings are a convenience; a failure to persist should not break downloads.
  }
  return next
}

/** Makes sure the chosen output folder still exists before a download starts. */
export function ensureOutputDir(): string {
  const dir = getSettings().outputDir
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
