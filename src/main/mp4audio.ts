/** Codecs MP4 can hold as-is, so the audio never gets re-encoded. */
const MP4_COPYABLE_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac'])

/** Copy the audio when MP4 can hold it, so it stays bit-identical to the source. */
export function audioArgs(codec: string | null): string[] {
  if (!codec) return []
  if (MP4_COPYABLE_AUDIO.has(codec.toLowerCase())) return ['-c:a', 'copy']
  return ['-c:a', 'aac', '-b:a', '192k']
}

export function isAudioCopied(codec: string | null): boolean {
  return codec !== null && MP4_COPYABLE_AUDIO.has(codec.toLowerCase())
}
