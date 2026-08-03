export { parseFfmpegProgress } from './ffprogress.ts'

import { SPEED_MAX, SPEED_MIN, REVERB_MAX, REVERB_MIN } from '../shared/types.ts'

/**
 * Slowed + reverb. Unlike the download side, this necessarily re-encodes — you
 * cannot resample and convolve a stream with `-c copy`. Everything here is a
 * deliberate render, not a passthrough.
 *
 * No Electron imports: the spawning lives in fxrun.ts so this file can be driven
 * straight from the tests.
 */

/** Impulse response shape. Fixed, because WET_UNITY_GAIN is calibrated to it. */
const IR_SECONDS = 2.5
const IR_DECAY = 4.5
const IR_LOWPASS = 5000
const IR_HIGHPASS = 120

/**
 * Wet gain that makes the reverb bus peak at roughly the dry signal's level.
 * Measured, not guessed: convolving the calibration tone through this IR landed
 * 27.6 dB below dry, and 10^(27.6/20) is ~24. afir's own `dry` mix is ignored in
 * the bundled build and its irnorm buries the wet bus, so the mix is done by hand.
 */
const WET_UNITY_GAIN = 24

/** Room for the reverb to ring out past the end of the source. */
const TAIL_SECONDS = 3

export function clampSpeed(v: number): number {
  if (!Number.isFinite(v)) return 0.85
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, v))
}

export function clampReverb(v: number): number {
  if (!Number.isFinite(v)) return 0.35
  return Math.min(REVERB_MAX, Math.max(REVERB_MIN, v))
}

/** Output length: the source stretched by the speed change, plus the tail. */
export function expectedDuration(durationIn: number, speed: number): number {
  return durationIn / speed + TAIL_SECONDS
}

/**
 * asetrate reinterprets the samples at a lower rate, so tempo and pitch drop
 * together — the record-played-slow sound the genre is named for. atempo would
 * hold pitch, which is not what anyone means by "slowed".
 */
export function buildFilterComplex(sampleRate: number, speed: number, reverb: number): string {
  const sr = Math.round(sampleRate)
  const slowed = Math.round(sr * speed)
  const wetGain = (WET_UNITY_GAIN * reverb).toFixed(4)

  const source =
    `[0:a]aresample=${sr},asetrate=${slowed},aresample=${sr},` +
    `aformat=sample_fmts=fltp:channel_layouts=stereo,apad=pad_dur=${TAIL_SECONDS},asplit=2[dry][pre]`

  // Two decorrelated noise tails make a stereo room; the envelope is the decay.
  const ir =
    `anoisesrc=r=${sr}:c=pink:a=1:d=${IR_SECONDS}:s=1,volume='exp(-${IR_DECAY}*t)':eval=frame[irl];` +
    `anoisesrc=r=${sr}:c=pink:a=1:d=${IR_SECONDS}:s=2,volume='exp(-${IR_DECAY}*t)':eval=frame[irr];` +
    `[irl][irr]join=inputs=2:channel_layout=stereo,` +
    `lowpass=f=${IR_LOWPASS},highpass=f=${IR_HIGHPASS}[ir]`

  const wet = `[pre][ir]afir=wet=1:gtype=peak:irnorm=1,volume=${wetGain}[wet]`

  // normalize=0 keeps both buses at unity; amix would otherwise halve them.
  const mix = `[dry][wet]amix=inputs=2:normalize=0:duration=longest,alimiter=limit=0.95:level=false[out]`

  return [source, ir, wet, mix].join(';')
}

export function buildFxArgs(opts: {
  input: string
  output: string
  sampleRate: number
  speed: number
  reverb: number
}): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'error',
    '-y',
    '-i', opts.input,
    '-filter_complex', buildFilterComplex(opts.sampleRate, opts.speed, opts.reverb),
    '-map', '[out]',
    '-c:a', 'libmp3lame',
    '-b:a', '320k',
    // Machine-readable progress on stdout, so stderr stays purely for errors.
    '-progress', 'pipe:1',
    '-nostats',
    opts.output
  ]
}

/** ffmpeg's stderr, reduced to something worth putting in a row. */
export function mapFxError(stderr: string, code: number | null): string {
  const text = stderr || ''
  if (/no such file|does not exist|no such directory/i.test(text)) {
    return 'That file is gone — it may have been moved or renamed.'
  }
  if (/invalid data found|could not find codec|decoder.*not found|moov atom not found/i.test(text)) {
    return 'That file is not audio this app can decode.'
  }
  if (/permission denied|access is denied/i.test(text)) {
    return 'Could not write to your output folder.'
  }
  if (/no space left|not enough space/i.test(text)) {
    return 'The drive holding your output folder is out of space.'
  }
  if (/unknown encoder|libmp3lame/i.test(text)) {
    return 'The bundled ffmpeg has no MP3 encoder. Reinstall the app.'
  }
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()
  if (line) return line.length > 200 ? `${line.slice(0, 197)}…` : line
  return `Render failed (exit code ${code ?? 'unknown'}). Open the log for details.`
}
