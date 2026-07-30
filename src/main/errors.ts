import type { DownloadError } from '@shared/types'

interface Rule {
  test: RegExp
  error: DownloadError
}

/**
 * yt-dlp's stderr is written for a terminal. Everything the user sees in a row
 * comes from here; the raw text only ever goes to the log file.
 */
const RULES: Rule[] = [
  {
    test: /sign in to confirm (you'?re|your age)|confirm your age|age[- ]restricted|inappropriate for some users/i,
    error: {
      message: 'This video is age-restricted. Turn on "Use browser cookies" and try again.',
      action: 'use-cookies'
    }
  },
  {
    test: /sign in to confirm you'?re not a bot|please sign in|login required|requires authentication|account.*required/i,
    error: {
      message: 'YouTube wants a signed-in session. Turn on "Use browser cookies" and try again.',
      action: 'use-cookies'
    }
  },
  {
    test: /members[- ]only|join this channel|available to (this channel'?s )?members/i,
    error: {
      message: 'Members-only video. Turn on "Use browser cookies" if your account has access.',
      action: 'use-cookies'
    }
  },
  {
    test: /could not (copy|find) chrome cookie|failed to (decrypt|read).*cookie|unable to (open|read) cookie|permission denied.*cookies/i,
    error: {
      message: 'Could not read Chrome cookies. Close Chrome completely and try again.',
      action: 'retry'
    }
  },
  {
    test: /private video|this video is private/i,
    error: { message: 'This video is private.', action: 'none' }
  },
  {
    test: /video unavailable|content is?n.t available|has been removed|no longer available|account associated with this video has been terminated|this video has been removed/i,
    error: { message: 'This video is unavailable or has been removed.', action: 'none' }
  },
  {
    test: /not available (in|from) your country|geo[- ]?restrict|blocked it in your country|is not available in your location/i,
    error: { message: 'This video is blocked in your region.', action: 'none' }
  },
  {
    test: /premieres in|this live event will begin|is not currently live|live event will begin/i,
    error: { message: 'This is a premiere or scheduled stream that has not started yet.', action: 'retry' }
  },
  {
    test: /no video (formats|could be) found|there'?s no video|photo mode|image post|slideshow|no video streams?/i,
    error: {
      message: 'This TikTok post is a photo slideshow — there is no video stream to download.',
      action: 'none'
    }
  },
  {
    test: /requested format (is )?not available|no formats? found matching/i,
    error: {
      message: 'No matching format was offered for this video. Try a different format button.',
      action: 'none'
    }
  },
  {
    test: /unable to extract|unsupported url|extractor.*fail|nonetype.*not (subscriptable|iterable)|failed to parse json|player response/i,
    error: {
      message: 'The extractor failed — yt-dlp is probably out of date. Run Check for updates.',
      action: 'update-ytdlp'
    }
  },
  {
    test: /yt-dlp is out of date|please update|new version.*available|update to.*by running/i,
    error: { message: 'yt-dlp is out of date. Run Check for updates.', action: 'update-ytdlp' }
  },
  {
    test: /\b(timed out|timeout|connection reset|connection aborted|temporary failure in name resolution|network is unreachable|getaddrinfo|econnrefused|remote end closed connection|incomplete read|read operation timed out)\b/i,
    error: { message: 'Network problem while downloading. Retry when your connection is back.', action: 'retry' }
  },
  {
    test: /http error 429|too many requests|rate[- ]?limit/i,
    error: { message: 'YouTube is rate-limiting this connection. Wait a few minutes, then retry.', action: 'retry' }
  },
  {
    test: /http error 40[34]|forbidden/i,
    error: { message: 'The server refused the request (403). Retry, or turn on browser cookies.', action: 'retry' }
  },
  {
    test: /no space left|not enough space|disk (is )?full/i,
    error: { message: 'The drive holding your download folder is out of space.', action: 'none' }
  },
  {
    test: /unable to (open|create|write|rename)|permission denied|access is denied|errno 13/i,
    error: { message: 'Could not write to your download folder. Pick a different folder.', action: 'none' }
  },
  {
    test: /ffmpeg (not found|is not installed)|ffprobe.*not found|unable to locate ffmpeg/i,
    error: { message: 'The bundled ffmpeg could not be started. Reinstall the app.', action: 'none' }
  },
  {
    test: /conversion failed|postprocessing|error opening output file|ffmpeg exited/i,
    error: { message: 'ffmpeg could not finish writing the file. See the log for details.', action: 'retry' }
  },
  {
    test: /is not a valid url|unsupported url/i,
    error: { message: 'That link is not something this app can download.', action: 'none' }
  }
]

/** True when the failure looks like the mp4 remux step choking on the streams. */
export function isRemuxFailure(stderr: string): boolean {
  return (
    /remux/i.test(stderr) ||
    (/postprocessing|conversion failed/i.test(stderr) && /mp4/i.test(stderr))
  )
}

export function mapError(stderr: string, exitCode: number | null): DownloadError {
  const text = stderr || ''
  for (const rule of RULES) {
    if (rule.test.test(text)) return rule.error
  }

  // Nothing matched. Surface the last real ERROR line, trimmed, rather than a
  // useless generic — but keep it to one sentence.
  const line = text
    .split(/\r?\n/)
    .reverse()
    .find((l) => /^\s*(ERROR|error):/i.test(l))
  if (line) {
    const cleaned = line
      .replace(/^\s*(ERROR|error):\s*/i, '')
      .replace(/;\s*please report this issue.*$/i, '')
      .replace(/\s*\(caused by .*\)\s*$/i, '')
      .trim()
    if (cleaned) {
      return {
        message: cleaned.length > 200 ? `${cleaned.slice(0, 197)}…` : cleaned,
        action: 'retry'
      }
    }
  }

  return {
    message: `Download failed (exit code ${exitCode ?? 'unknown'}). Open the log for details.`,
    action: 'retry'
  }
}
