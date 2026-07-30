export function bytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

export function speed(bytesPerSecond: number | undefined): string {
  if (bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) return ''
  return `${bytes(bytesPerSecond)}/s`
}

export function eta(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return ''
  const s = Math.round(seconds)
  if (s < 60) return `${s}s left`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s left`
  return `${Math.floor(m / 60)}h ${m % 60}m left`
}

export function duration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return ''
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}
