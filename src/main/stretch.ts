import type { AspectId, FitMode } from '../shared/types.ts'
import { ASPECTS } from '../shared/types.ts'
import { audioArgs, isAudioCopied } from './mp4audio.ts'

// Re-exported so the stretch tab's callers and tests keep one import site.
export { audioArgs, isAudioCopied }

/**
 * Reframing video to a new aspect ratio. This re-encodes — scaling, cropping and
 * padding all touch every pixel, and there is no `-c copy` path for any of them.
 * What it does avoid: the audio is stream-copied untouched whenever the source
 * codec is legal in MP4, and the video never gets downscaled below the source's
 * effective detail.
 */

/** Visually lossless for practical purposes; 18 is the usual "can't tell" line. */
const CRF = '17'
const PRESET = 'medium'

export interface Size {
  width: number
  height: number
}

function evenRound(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

/**
 * Output size for a source reframed to `aspect`.
 *
 * Equal pixel count with the source, which lands on the sizes people expect
 * without inventing detail: 1920x1080 to 9:16 gives exactly 1080x1920, and to
 * 1:1 gives 1440x1440. Height is derived from the rounded width so the ratio
 * stays as close as even dimensions allow — H.264 in yuv420p needs both even.
 */
export function outputSize(source: Size, aspect: AspectId): Size {
  const { w: arW, h: arH } = ASPECTS[aspect]
  const area = Math.max(1, source.width * source.height)
  const k = Math.sqrt(area / (arW * arH))

  const width = evenRound(arW * k)
  const height = evenRound((width * arH) / arW)
  return { width, height }
}

/**
 * Every mode ends in [vout]. force_original_aspect_ratio does the heavy lifting:
 * `increase` scales until the frame covers the target (then we crop the excess),
 * `decrease` scales until it fits inside (then we fill the gap).
 */
export function buildVideoFilter(mode: FitMode, out: Size): string {
  const { width: w, height: h } = out
  const scaleFlags = 'flags=lanczos'

  switch (mode) {
    case 'stretch':
      // Non-uniform scale. Fills the frame exactly and distorts to do it.
      return `[0:v]scale=${w}:${h}:${scaleFlags},setsar=1[vout]`

    case 'crop':
      return (
        `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase:${scaleFlags},` +
        `crop=${w}:${h},setsar=1[vout]`
      )

    case 'pad':
      return (
        `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease:${scaleFlags},` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[vout]`
      )

    case 'blur': {
      // Blur scales with the frame, or a 4K render looks barely blurred at all.
      const sigma = Math.max(10, Math.round(Math.min(w, h) / 40))
      return (
        `[0:v]split=2[bg][fg];` +
        `[bg]scale=${w}:${h}:force_original_aspect_ratio=increase:${scaleFlags},` +
        `crop=${w}:${h},gblur=sigma=${sigma},eq=brightness=-0.08[bgb];` +
        `[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease:${scaleFlags}[fgs];` +
        `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[vout]`
      )
    }
  }
}


export interface StretchArgsOptions {
  input: string
  output: string
  source: Size
  aspect: AspectId
  mode: FitMode
  audioCodec: string | null
}

export function buildStretchArgs(opts: StretchArgsOptions): string[] {
  const out = outputSize(opts.source, opts.aspect)

  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'error',
    '-y',
    '-i', opts.input,
    '-filter_complex', buildVideoFilter(opts.mode, out),
    '-map', '[vout]',
    // Optional so a silent source does not fail the whole render.
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', PRESET,
    '-crf', CRF,
    '-pix_fmt', 'yuv420p',
    ...audioArgs(opts.audioCodec),
    // Lets a phone start playing before the whole file has landed.
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-nostats',
    opts.output
  ]
}

/** ffmpeg's stderr, reduced to something worth putting in a row. */
export function mapStretchError(stderr: string, code: number | null): string {
  const text = stderr || ''
  if (/no such file|does not exist/i.test(text)) {
    return 'That file is gone — it may have been moved or renamed.'
  }
  if (/invalid data found|moov atom not found|could not find codec|decoder.*not found/i.test(text)) {
    return 'That file is not video this app can decode.'
  }
  if (/permission denied|access is denied/i.test(text)) {
    return 'Could not write to your output folder.'
  }
  if (/no space left|not enough space/i.test(text)) {
    return 'The drive holding your output folder is out of space.'
  }
  if (/unknown encoder|libx264/i.test(text)) {
    return 'The bundled ffmpeg has no H.264 encoder. Reinstall the app.'
  }
  if (/codec not currently supported in container|could not write header/i.test(text)) {
    return 'That audio track will not fit in an MP4. Retry — it will be converted.'
  }
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()
  if (line) return line.length > 200 ? `${line.slice(0, 197)}…` : line
  return `Render failed (exit code ${code ?? 'unknown'}). Open the log for details.`
}
