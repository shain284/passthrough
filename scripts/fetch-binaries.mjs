#!/usr/bin/env node
/**
 * Downloads the yt-dlp and ffmpeg sidecars into resources/bin/<platform>/.
 *
 * The binaries are deliberately not committed — they are large, they change
 * often, and yt-dlp self-updates in place anyway. Run this once after cloning:
 *
 *   node scripts/fetch-binaries.mjs
 *
 * ffmpeg comes from yt-dlp's own build rather than upstream: those builds carry
 * patches yt-dlp depends on for AAC/HLS handling.
 */
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'

const execFileAsync = promisify(execFile)

const root = path.resolve(import.meta.dirname, '..')
const platform = process.platform
const outDir = path.join(root, 'resources', 'bin', platform)

// Nightly, not stable. Stable lags YouTube's player changes by weeks, which
// shows up as 403s partway through downloads.
const YT_DLP = {
  win32: 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp.exe',
  darwin: 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_macos',
  linux: 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux'
}

const FFMPEG_ARCHIVE = {
  win32: `https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip`,
  darwin: `https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-macos64-gpl.zip`,
  linux: `https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz`
}

/**
 * Optional third sidecar. yt-dlp deprecated YouTube extraction without a JS
 * runtime and only auto-detects deno, so a machine without one can silently lose
 * formats. Fetch with `--with-deno` (adds ~110 MB to the installer).
 */
const DENO = {
  win32: 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip',
  darwin: 'https://github.com/denoland/deno/releases/latest/download/deno-aarch64-apple-darwin.zip',
  linux: 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip'
}

/**
 * Real-ESRGAN for the upscale tab. Required rather than optional — without it
 * that tab cannot do anything. Small: ~6 MB binary plus ~13 MB of anime models.
 */
const REALESRGAN = {
  win32: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip',
  darwin: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-macos.zip',
  linux: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip'
}

/** Only the anime models ship; the photo ones are dead weight for this app. */
const KEEP_MODELS = [
  'realesr-animevideov3-x2',
  'realesr-animevideov3-x3',
  'realesr-animevideov3-x4',
  'realesrgan-x4plus-anime'
]

const exeSuffix = platform === 'win32' ? '.exe' : ''

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function download(url, dest) {
  process.stdout.write(`  fetching ${url}\n`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  const tmp = `${dest}.part`
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
  await rename(tmp, dest)
}

async function extractFfmpeg(archive, workDir) {
  if (archive.endsWith('.zip')) {
    if (platform === 'win32') {
      await execFileAsync(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${workDir}' -Force`],
        { maxBuffer: 32 * 1024 * 1024 }
      )
    } else {
      await execFileAsync('unzip', ['-oq', archive, '-d', workDir])
    }
  } else {
    await execFileAsync('tar', ['-xf', archive, '-C', workDir])
  }

  // The archives nest everything under ffmpeg-*/bin/.
  const { stdout } = await execFileAsync(
    platform === 'win32' ? 'powershell' : 'sh',
    platform === 'win32'
      ? [
          '-NoProfile',
          '-Command',
          `Get-ChildItem -Recurse -File -Path '${workDir}' -Include ffmpeg.exe,ffprobe.exe | Select-Object -ExpandProperty FullName`
        ]
      : ['-c', `find '${workDir}' -type f \\( -name ffmpeg -o -name ffprobe \\)`],
    { maxBuffer: 8 * 1024 * 1024 }
  )

  const found = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (!found.length) throw new Error('No ffmpeg/ffprobe found inside the archive.')
  for (const src of found) {
    const dest = path.join(outDir, path.basename(src))
    await rename(src, dest).catch(async () => {
      const { copyFile } = await import('node:fs/promises')
      await copyFile(src, dest)
    })
    if (platform !== 'win32') await chmod(dest, 0o755)
    process.stdout.write(`  wrote ${dest}\n`)
  }
}

async function main() {
  const force = process.argv.includes('--force')
  if (!YT_DLP[platform]) throw new Error(`Unsupported platform: ${platform}`)

  await mkdir(outDir, { recursive: true })
  process.stdout.write(`Sidecars → ${outDir}\n`)

  const ytDlpDest = path.join(outDir, `yt-dlp${exeSuffix}`)
  if (force || !(await exists(ytDlpDest))) {
    await download(YT_DLP[platform], ytDlpDest)
    if (platform !== 'win32') await chmod(ytDlpDest, 0o755)
    process.stdout.write(`  wrote ${ytDlpDest}\n`)
  } else {
    process.stdout.write('  yt-dlp already present (pass --force to replace)\n')
  }

  const ffmpegDest = path.join(outDir, `ffmpeg${exeSuffix}`)
  if (force || !(await exists(ffmpegDest))) {
    const workDir = await (await import('node:fs/promises')).mkdtemp(
      path.join(os.tmpdir(), 'ffmpeg-')
    )
    const archiveUrl = FFMPEG_ARCHIVE[platform]
    const archive = path.join(workDir, path.basename(new URL(archiveUrl).pathname))
    try {
      await download(archiveUrl, archive)
      await extractFfmpeg(archive, workDir)
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  } else {
    process.stdout.write('  ffmpeg already present (pass --force to replace)\n')
  }

  const upscalerDest = path.join(outDir, `realesrgan-ncnn-vulkan${exeSuffix}`)
  if (force || !(await exists(upscalerDest))) {
    const workDir = await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'esrgan-'))
    const archive = path.join(workDir, 'realesrgan.zip')
    try {
      await download(REALESRGAN[platform], archive)
      if (platform === 'win32') {
        await execFileAsync('powershell', [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${workDir}' -Force`
        ])
      } else {
        await execFileAsync('unzip', ['-oq', archive, '-d', workDir])
      }

      const { copyFile, readdir: readDir } = await import('node:fs/promises')
      const found = await readDir(workDir, { recursive: true, withFileTypes: true })
      await mkdir(path.join(outDir, 'models'), { recursive: true })

      for (const entry of found) {
        if (!entry.isFile()) continue
        const src = path.join(entry.parentPath ?? entry.path, entry.name)
        // The binary, the OpenMP runtime it needs, and the anime models only.
        if (entry.name === `realesrgan-ncnn-vulkan${exeSuffix}` || /^vcomp\d+\.dll$/i.test(entry.name)) {
          await copyFile(src, path.join(outDir, entry.name))
          if (platform !== 'win32') await chmod(path.join(outDir, entry.name), 0o755)
        } else if (KEEP_MODELS.some((m) => entry.name.startsWith(m))) {
          await copyFile(src, path.join(outDir, 'models', entry.name))
        }
      }
      process.stdout.write(`  wrote ${upscalerDest} and models/\n`)
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  } else {
    process.stdout.write('  realesrgan already present (pass --force to replace)\n')
  }

  const denoDest = path.join(outDir, `deno${exeSuffix}`)
  if (process.argv.includes('--with-deno') && (force || !(await exists(denoDest)))) {
    const workDir = await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'deno-'))
    const archive = path.join(workDir, 'deno.zip')
    try {
      await download(DENO[platform], archive)
      if (platform === 'win32') {
        await execFileAsync('powershell', [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${workDir}' -Force`
        ])
      } else {
        await execFileAsync('unzip', ['-oq', archive, '-d', workDir])
      }
      const src = path.join(workDir, `deno${exeSuffix}`)
      await rename(src, denoDest)
      if (platform !== 'win32') await chmod(denoDest, 0o755)
      process.stdout.write(`  wrote ${denoDest}\n`)
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }

  process.stdout.write('Done.\n')
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`)
  process.exit(1)
})
