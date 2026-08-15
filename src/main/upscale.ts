import type { UpscaleFactor } from '../shared/types.ts'
import { audioArgs } from './mp4audio.ts'

/**
 * Neural upscaling with Real-ESRGAN's anime video model.
 *
 * This is by far the heaviest thing the app does — measured at ~3 fps for 2x on
 * 640x480 with an integrated Radeon 780M, so a 30 second clip takes about four
 * minutes and a full episode takes hours. It is built for clips.
 *
 * Frames are processed in chunks rather than all at once. A 24 minute episode at
 * 4x would need ~191 GB of intermediate PNGs if extracted in one go; chunking
 * bounds scratch space to a couple of GB no matter how long the input is.
 *
 * No Electron imports: the spawning lives in upscalerun.ts.
 */

/** The model built for anime video specifically — faster and cleaner than the photo models. */
export const MODEL = 'realesr-animevideov3'

/** Frames per chunk. 300 keeps scratch under ~2 GB even at 4x. */
export const CHUNK_FRAMES = 300

const CRF = '17'
const PRESET = 'medium'

/**
 * Measured throughput on a Radeon 780M at 640x480 (307,200 px), in frames/sec.
 * Used only for the first estimate — once a chunk finishes, the row switches to
 * the rate actually being achieved, which is far more honest than any model.
 */
const REFERENCE_PIXELS = 640 * 480
const REFERENCE_FPS: Record<UpscaleFactor, number> = { 2: 2.98, 3: 2.3, 4: 1.8 }

export interface Size {
  width: number
  height: number
}

function evenRound(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

/** Real-ESRGAN multiplies both dimensions; H.264 then needs them even. */
export function upscaledSize(source: Size, factor: UpscaleFactor): Size {
  return {
    width: evenRound(source.width * factor),
    height: evenRound(source.height * factor)
  }
}

/** Rough first estimate, in seconds. Scales off source pixel count. */
export function estimateSeconds(
  frameCount: number,
  source: Size,
  factor: UpscaleFactor
): number {
  const pixels = Math.max(1, source.width * source.height)
  const fps = REFERENCE_FPS[factor] * (REFERENCE_PIXELS / pixels)
  return frameCount / Math.max(0.05, fps)
}

/** Bytes of scratch space one chunk needs, for the pre-flight disk check. */
export function chunkScratchBytes(source: Size, factor: UpscaleFactor): number {
  const out = upscaledSize(source, factor)
  // ~3 bytes/px for PNG of flat anime line art, plus the source frames.
  return CHUNK_FRAMES * (out.width * out.height + source.width * source.height) * 3
}

export interface ChunkRange {
  index: number
  startFrame: number
  frameCount: number
}

export function planChunks(totalFrames: number, chunkFrames = CHUNK_FRAMES): ChunkRange[] {
  const chunks: ChunkRange[] = []
  for (let start = 0, i = 0; start < totalFrames; start += chunkFrames, i++) {
    chunks.push({
      index: i,
      startFrame: start,
      frameCount: Math.min(chunkFrames, totalFrames - start)
    })
  }
  return chunks
}

/**
 * Pull one chunk's frames out as PNG. Input seeking keeps this O(1) per chunk
 * rather than re-decoding from the start every time, and -fps_mode passthrough
 * stops ffmpeg inventing or dropping frames to hit a target rate.
 */
export function buildExtractArgs(opts: {
  input: string
  startFrame: number
  frameCount: number
  fps: number
  outDir: string
}): string[] {
  const startSeconds = opts.startFrame / opts.fps
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    // Before -i so it seeks rather than decoding and discarding.
    '-ss', startSeconds.toFixed(6),
    '-i', opts.input,
    '-frames:v', String(opts.frameCount),
    '-fps_mode', 'passthrough',
    `${opts.outDir}/%08d.png`
  ]
}

export function buildUpscaleArgs(opts: {
  inDir: string
  outDir: string
  factor: UpscaleFactor
  modelDir: string
}): string[] {
  return [
    '-i', opts.inDir,
    '-o', opts.outDir,
    '-n', MODEL,
    '-s', String(opts.factor),
    '-m', opts.modelDir,
    '-f', 'png'
  ]
}

/** Encode one chunk's upscaled frames into a segment. */
export function buildSegmentArgs(opts: {
  frameDir: string
  fps: number
  output: string
}): string[] {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-framerate', String(opts.fps),
    '-i', `${opts.frameDir}/%08d.png`,
    '-c:v', 'libx264',
    '-preset', PRESET,
    '-crf', CRF,
    '-pix_fmt', 'yuv420p',
    '-fps_mode', 'passthrough',
    opts.output
  ]
}

/**
 * Join the segments and put the original audio back. Video is a stream copy —
 * the segments are already encoded, so this pass re-encodes nothing.
 */
export function buildJoinArgs(opts: {
  listFile: string
  original: string
  output: string
  audioCodec: string | null
}): string[] {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', opts.listFile,
    '-i', opts.original,
    '-map', '0:v:0',
    '-map', '1:a:0?',
    '-c:v', 'copy',
    ...audioArgs(opts.audioCodec),
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-nostats',
    opts.output
  ]
}

/** Real-ESRGAN reports progress as bare percentages on stderr. */
export function parseUpscalePercent(line: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)%\s*$/.exec(line)
  if (!m) return null
  const pct = Number(m[1])
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null
  return pct
}

export function mapUpscaleError(stderr: string, code: number | null): string {
  const text = stderr || ''
  if (/vkCreateInstance|vulkan|no gpu device|failed to create instance/i.test(text)) {
    return 'No Vulkan GPU was available. Update your graphics driver and try again.'
  }
  if (/out of memory|vkAllocateMemory|device lost/i.test(text)) {
    return 'The GPU ran out of memory. Try a smaller scale, or a shorter clip.'
  }
  if (/no such file|does not exist/i.test(text)) {
    return 'That file is gone — it may have been moved or renamed.'
  }
  if (/invalid data found|moov atom not found|decoder.*not found/i.test(text)) {
    return 'That file is not video this app can decode.'
  }
  if (/no space left|not enough space/i.test(text)) {
    return 'Ran out of disk space while writing frames. Free some space and retry.'
  }
  if (/find_blob_index_by_name|param is empty|failed to load model/i.test(text)) {
    return 'The upscaling model failed to load. Reinstall the app.'
  }
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\d+(\.\d+)?%$/.test(l))
    .pop()
  if (line) return line.length > 200 ? `${line.slice(0, 197)}…` : line
  return `Upscale failed (exit code ${code ?? 'unknown'}). Open the log for details.`
}
