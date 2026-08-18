import type { DownloadError } from '../shared/types.ts'

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
    // Chrome's app-bound encryption (Chrome 127+) put cookies behind DPAPI in a
    // way yt-dlp cannot unwrap. Closing Chrome does not help, so do not say it.
    test: /failed to decrypt with dpapi|app-?bound|10927/i,
    error: {
      message:
        'Chrome now encrypts its cookies in a way this cannot read. Use Firefox, or turn the cookie option off.',
      action: 'none'
    }
  },
  {
    test: /could not (copy|find) chrome cookie|failed to (decrypt|read).*cookie|unable to (open|read) cookie|permission denied.*cookies/i,
    error: {
      message: 'Could not read browser cookies. Close the browser completely and try again.',
      action: 'retry'
    }
  },
  {
    // "Private video. Sign in if you have been granted access to this video" is
    // recoverable with cookies; a plain private video is not. Order matters.
    test: /sign in if you have been granted access|granted access to this video/i,
    error: {
      message: 'This video is private. If your account has access, turn on "Use browser cookies".',
      action: 'use-cookies'
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
    // Covers yt-dlp's actual wording: "The uploader has not made this video
    // available in your country".
    test: /available (in|from) your (country|location)|geo[- ]?restrict|blocked it in your country/i,
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
    error: {
      // A 403 partway through a transfer means YouTube served a URL the
      // extractor negotiated and then rejected it — almost always a stale
      // yt-dlp against a changed player, not a problem with the video.
      message: 'YouTube refused this video’s stream. Run Check for updates — a stale extractor is the usual cause.',
      action: 'update-ytdlp'
    }
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
