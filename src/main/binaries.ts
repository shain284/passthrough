import { app } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Sidecar binaries live in resources/bin/<platform>/ and are copied into the
 * packaged app via electron-builder's extraResources.
 */
const base = app.isPackaged
  ? path.join(process.resourcesPath, 'bin', process.platform)
  : path.join(__dirname, '../../resources/bin', process.platform)

const exe = process.platform === 'win32' ? '.exe' : ''

export const binDir = base
export const ytDlpPath = path.join(base, `yt-dlp${exe}`)
export const ffmpegPath = path.join(base, `ffmpeg${exe}`)
export const ffprobePath = path.join(base, `ffprobe${exe}`)
export const denoPath = path.join(base, `deno${exe}`)

/** Real-ESRGAN and its models, for the upscale tab. */
export const realesrganPath = path.join(base, `realesrgan-ncnn-vulkan${exe}`)
export const modelsDir = path.join(base, 'models')

/**
 * yt-dlp deprecated YouTube extraction without a JavaScript runtime — without one
 * some formats can go missing. It only auto-detects deno, and a clean machine has
 * none, so point it at a bundled copy when one is there. Optional: drop deno into
 * resources/bin/<platform>/ (npm run binaries -- --with-deno) and this lights up.
 */
export function jsRuntimeArgs(): string[] {
  try {
    if (fs.existsSync(denoPath)) return ['--js-runtimes', `deno:${denoPath}`]
  } catch {
    /* fall through to yt-dlp's own detection */
  }
  return []
}

/** yt-dlp wants the directory, not the executable, for --ffmpeg-location. */
export const ffmpegDir = base

/**
 * Git and npm do not preserve the executable bit for everyone, and extraResources
 * copies verbatim. Make the sidecars runnable on first launch on POSIX.
 */
export function ensureExecutable(): void {
  if (process.platform === 'win32') return
  for (const p of [ytDlpPath, ffmpegPath, ffprobePath, denoPath, realesrganPath]) {
    try {
      if (!fs.existsSync(p)) continue
      const mode = fs.statSync(p).mode & 0o777
      if (mode !== 0o755) fs.chmodSync(p, 0o755)
    } catch {
      // Non-fatal: spawn will surface a clearer error than we could here.
    }
  }
}

export function missingBinaries(): string[] {
  return [ytDlpPath, ffmpegPath].filter((p) => !fs.existsSync(p))
}

/** Environment every sidecar spawn inherits. */
export function spawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // yt-dlp is a frozen Python app; without this it can die on non-ASCII titles
    // when stdout is a pipe on Windows.
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1'
  }
}

function run(file: string, args: string[], timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout, windowsHide: true, env: spawnEnv(), maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message))
        else resolve(stdout.trim())
      }
    )
  })
}

export async function ytDlpVersion(): Promise<string | null> {
  try {
    return await run(ytDlpPath, ['--version'])
  } catch {
    return null
  }
}

export async function ffmpegVersion(): Promise<string | null> {
  try {
    const out = await run(ffmpegPath, ['-version'])
    const first = out.split('\n')[0] ?? ''
    return first.replace(/^ffmpeg version\s*/i, '').split(' ')[0] || first
  } catch {
    return null
  }
}

/** yt-dlp -U. Self-updates the binary in place; needs write access to resources/bin. */
export async function selfUpdate(): Promise<{ ok: boolean; output: string }> {
  try {
    const out = await run(ytDlpPath, ['-U'], 120000)
    return { ok: true, output: out || 'yt-dlp is up to date.' }
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) }
  }
}
