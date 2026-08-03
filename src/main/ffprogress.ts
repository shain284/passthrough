/**
 * Pulls the output position out of ffmpeg's -progress stream, in seconds.
 *
 * Both out_time_us and out_time_ms are microseconds — ffmpeg has emitted the
 * identical value under both keys for years despite the name. Dividing the "ms"
 * line by 1000 puts the position a thousand times too far along, which pins the
 * bar at 100% the moment the first progress block arrives.
 */
export function parseFfmpegProgress(line: string): number | null {
  const match = /^out_time_(?:us|ms)=(-?\d+)$/.exec(line.trim())
  if (!match) return null
  const microseconds = Number(match[1])
  if (!Number.isFinite(microseconds) || microseconds < 0) return null
  return microseconds / 1_000_000
}
