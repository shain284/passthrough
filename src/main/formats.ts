import type { FormatId } from '../shared/types.ts'

export const PROGRESS_PREFIX = 'PROG|'
export const POSTPROCESS_PREFIX = 'PPROG|'
export const FILE_PREFIX = 'FILE|'

/**
 * Machine-readable progress instead of scraping the console renderer.
 * total_bytes_estimate rides along because total_bytes comes back NA on
 * fragmented (HLS/DASH) streams and we need something to fall back to.
 */
const PROGRESS_TEMPLATE =
  'PROG|%(progress.downloaded_bytes)d|%(progress.total_bytes)d|' +
  '%(progress.total_bytes_estimate)d|%(progress.speed)f|%(progress.eta)d'

const OUTPUT_TEMPLATE = '%(title).80s [%(id)s].%(ext)s'

export interface BuildOptions {
  url: string
  format: FormatId
  outputDir: string
  /** Directory holding the bundled ffmpeg. Injected so this module stays
   *  independent of Electron and can be exercised by the integration test. */
  ffmpegDir: string
  useCookies: boolean
  /** Second pass after a failed mp4 remux: keep the mkv, do not transcode. */
  keepMkv?: boolean
  /** e.g. ['--js-runtimes', 'deno:<path>'] when a runtime is bundled. */
  extraArgs?: string[]
}

/**
 * Per-format arguments. Every one of these is a stream copy or a passthrough —
 * nothing here re-encodes video, ever. --recode-video is deliberately absent.
 */
function formatArgs(format: FormatId, keepMkv: boolean): string[] {
  switch (format) {
    case 'mp4':
      // Prefer formats that are already mp4/m4a so the merge is a plain copy.
      // When the best video is VP9 or AV1 in webm, --remux-video rewraps it into
      // mp4 with `-c copy` rather than dropping to a worse mp4-native format.
      return keepMkv
        ? ['-f', 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b', '--merge-output-format', 'mkv']
        : [
            '-f',
            'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b',
            '--merge-output-format',
            'mp4',
            '--remux-video',
            'mp4'
          ]

    case 'audio-original':
      // --audio-format best tells yt-dlp to keep whatever the source audio is.
      // Lands as .m4a (AAC) or .opus with the bytes untouched.
      return [
        '-f',
        'ba',
        '-x',
        '--audio-format',
        'best',
        '--embed-thumbnail',
        '--embed-metadata'
      ]

    case 'mp3-320':
      return [
        '-f',
        'ba',
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '320K',
        '--embed-thumbnail',
        '--embed-metadata'
      ]

    case 'mp3-v0':
      return [
        '-f',
        'ba',
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '0',
        '--embed-thumbnail',
        '--embed-metadata'
      ]
  }
}

export function buildDownloadArgs(opts: BuildOptions): string[] {
  const args = [
    ...formatArgs(opts.format, opts.keepMkv === true),

    '--newline',
    '--no-playlist',
    '--no-mtime',
    '--no-colors',
    '-o',
    OUTPUT_TEMPLATE,
    '--paths',
    opts.outputDir,

    '--progress-template',
    PROGRESS_TEMPLATE,
    // Merge/extract/embed run after the bytes land; this is what flips the row to
    // "Processing" instead of leaving a full bar sitting there looking stuck.
    '--progress-template',
    'postprocess:PPROG|%(progress.status)s|%(progress.postprocessor)s',
    // --print implies --quiet; --progress and --no-simulate put the download back.
    '--print',
    `after_move:${FILE_PREFIX}%(filepath)s`,
    '--no-simulate',
    '--progress',

    '--ffmpeg-location',
    opts.ffmpegDir
  ]

  if (opts.extraArgs?.length) args.push(...opts.extraArgs)
  if (opts.useCookies) args.push('--cookies-from-browser', 'chrome')

  args.push('--', opts.url)
  return args
}

export function buildMetaArgs(url: string, useCookies: boolean, extraArgs: string[] = []): string[] {
  const args = [
    '--dump-single-json',
    '--no-download',
    '--no-playlist',
    '--no-warnings',
    '--no-colors',
    ...extraArgs
  ]
  if (useCookies) args.push('--cookies-from-browser', 'chrome')
  args.push('--', url)
  return args
}

export const FORMAT_LABELS: Record<FormatId, string> = {
  mp4: 'MP4 (best)',
  'audio-original': 'Audio (original)',
  'mp3-320': 'MP3 320',
  'mp3-v0': 'MP3 V0'
}
