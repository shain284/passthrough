/**
 * Integration checks that need real binaries and a real network, run outside
 * Electron:
 *
 *   node --test test/integration.ts
 *
 * Node 24 strips the types natively. Every module imported here is deliberately
 * free of Electron imports so the test can drive the same code the app does.
 */
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { readdir, mkdtemp, rm } from 'node:fs/promises'
import { test } from 'node:test'
import os from 'node:os'
import path from 'node:path'

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  buildFilterComplex,
  clampReverb,
  clampSpeed,
  expectedDuration,
  mapFxError,
  parseFfmpegProgress
} from '../src/main/audiofx.ts'
import { buildDownloadArgs, FILE_PREFIX, POSTPROCESS_PREFIX } from '../src/main/formats.ts'
import { parseProgressLine } from '../src/main/progress.ts'
import { cleanupPartials, killTree } from '../src/main/proc.ts'
import { isRemuxFailure, mapError } from '../src/main/errors.ts'
import { normalizeUrl } from '../src/main/urls.ts'

const binDir = path.resolve(import.meta.dirname, '..', 'resources', 'bin', process.platform)
const exe = process.platform === 'win32' ? '.exe' : ''
const ytDlp = path.join(binDir, `yt-dlp${exe}`)
const ffmpeg = path.join(binDir, `ffmpeg${exe}`)
const ffprobe = path.join(binDir, `ffprobe${exe}`)
const run = promisify(execFile)

/** ~10 minutes of 4K60 — long enough that cancelling lands mid-stream. */
const LONG_VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'

const PARTIAL = /\.(part|ytdl)$|\.part-Frag\d+$|\.f\d+\.[A-Za-z0-9]{1,5}$|\.temp\.[A-Za-z0-9]{1,5}$/

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'passthrough-test-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('url allowlist accepts YouTube and TikTok and rejects everything else', () => {
  for (const ok of [
    'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    'https://youtu.be/jNQXAC9IVRw',
    'https://m.youtube.com/watch?v=jNQXAC9IVRw',
    'https://vm.tiktok.com/ZMabcdefg/',
    'http://www.tiktok.com/@nasa/video/123'
  ]) {
    assert.ok(normalizeUrl(ok), `expected ${ok} to be allowed`)
  }

  for (const bad of [
    'https://evil.com/watch?v=1',
    'https://youtube.com.evil.com/watch?v=1',
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'https://user:pass@youtube.com/watch?v=1',
    '; rm -rf /',
    'not a url',
    ''
  ]) {
    assert.equal(normalizeUrl(bad), null, `expected ${bad} to be rejected`)
  }

  // http is upgraded, the fragment is dropped, the query is left alone.
  assert.equal(
    normalizeUrl('http://youtu.be/abc?t=30#frag'),
    'https://youtu.be/abc?t=30'
  )
})

test('progress lines parse, including the NA fallbacks', () => {
  assert.deepEqual(parseProgressLine('PROG|1024|2048|NA|500.5|3'), {
    downloadedBytes: 1024,
    totalBytes: 2048,
    totalIsEstimate: false,
    speed: 500.5,
    eta: 3
  })

  // Fragmented stream: total_bytes NA, estimate present.
  const est = parseProgressLine('PROG|1024|NA|9000|NA|NA')
  assert.equal(est?.totalBytes, 9000)
  assert.equal(est?.totalIsEstimate, true)
  assert.equal(est?.speed, undefined)

  // Neither known -> indeterminate bar.
  assert.equal(parseProgressLine('PROG|1024|NA|NA|NA|NA')?.totalBytes, undefined)

  assert.equal(parseProgressLine('[download] 12% of 3MiB'), null)
})

test('format args never re-encode video', () => {
  const base = { url: 'https://youtu.be/x', outputDir: '/out', ffmpegDir: '/ff', useCookies: false }

  for (const format of ['mp4', 'audio-original', 'mp3-320', 'mp3-v0'] as const) {
    const args = buildDownloadArgs({ ...base, format })
    assert.ok(!args.includes('--recode-video'), `${format} must not recode`)
    assert.ok(args.includes('--no-playlist'))
    assert.ok(args.includes('--no-mtime'))
    assert.ok(args.includes('--newline'))
    // The URL is always last and always behind `--`.
    assert.equal(args.at(-1), 'https://youtu.be/x')
    assert.equal(args.at(-2), '--')
  }

  const mp4 = buildDownloadArgs({ ...base, format: 'mp4' })
  assert.ok(mp4.includes('--merge-output-format') && mp4.includes('mp4'))
  assert.ok(mp4.includes('--remux-video'))

  // The mkv fallback drops the remux instead of transcoding.
  const mkv = buildDownloadArgs({ ...base, format: 'mp4', keepMkv: true })
  assert.ok(!mkv.includes('--remux-video'))
  assert.ok(mkv.includes('mkv'))

  const audio = buildDownloadArgs({ ...base, format: 'audio-original' })
  assert.ok(audio.includes('best'), 'audio-original must pass the source through')

  assert.ok(buildDownloadArgs({ ...base, format: 'mp3-320' }).includes('320K'))
  assert.ok(buildDownloadArgs({ ...base, format: 'mp3-v0' }).includes('0'))

  assert.ok(
    buildDownloadArgs({ ...base, format: 'mp4', useCookies: true }).includes('--cookies-from-browser')
  )
})

test('stderr maps to plain English with the right offered action', () => {
  const cases: [string, string][] = [
    ['ERROR: [youtube] x: Sign in to confirm your age', 'use-cookies'],
    ['ERROR: [youtube] x: Private video. Sign in if you have been granted access', 'use-cookies'],
    ['ERROR: [youtube] x: Video unavailable', 'none'],
    ['ERROR: [youtube] x: The uploader has not made this video available in your country', 'none'],
    ['ERROR: [TikTok] x: No video formats found!', 'none'],
    ['ERROR: unable to extract player response; please report this issue', 'update-ytdlp'],
    ['ERROR: unable to download video data: The read operation timed out', 'retry'],
    ['ERROR: [youtube] x: HTTP Error 429: Too Many Requests', 'retry']
  ]
  for (const [stderr, action] of cases) {
    const mapped = mapError(stderr, 1)
    assert.equal(mapped.action, action, `${stderr} -> ${mapped.action}`)
    assert.ok(mapped.message.length > 0)
    assert.ok(!mapped.message.includes('ERROR:'), 'raw yt-dlp prefix must not reach the UI')
  }

  // Unknown errors still surface something specific rather than a shrug.
  assert.match(mapError('ERROR: something entirely new happened', 1).message, /something entirely new/)

  assert.ok(isRemuxFailure('ERROR: Postprocessing: Conversion failed! (remux to mp4)'))
  assert.ok(!isRemuxFailure('ERROR: Video unavailable'))
})

test(
  'cancelling mid-download kills the process tree and leaves no .part files',
  { timeout: 180_000 },
  async () => {
    await withTempDir(async (dir) => {
      const args = buildDownloadArgs({
        url: LONG_VIDEO,
        format: 'mp4',
        outputDir: dir,
        ffmpegDir: binDir,
        useCookies: false
      })

      const startedAt = Date.now()
      const child = spawn(ytDlp, args, {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let videoId: string | undefined
      let sawProgress = false
      let downloaded = 0

      const killedOnce = new Promise<void>((resolve) => {
        let buffer = ''
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8')
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const p = parseProgressLine(line.trim())
            if (!p) {
              if (line.startsWith(FILE_PREFIX) || line.startsWith(POSTPROCESS_PREFIX)) {
                throw new Error('download finished before we could cancel it')
              }
              continue
            }
            sawProgress = true
            downloaded = p.downloadedBytes ?? 0
            // Let a few MB land so there is a real .part file to clean up.
            if (downloaded > 3_000_000) resolve()
          }
        })
      })

      await killedOnce
      assert.ok(sawProgress, 'expected progress lines before cancelling')

      // The .part file must exist at this point, or the test proves nothing.
      const beforeKill = (await readdir(dir)).filter((f) => PARTIAL.test(f))
      assert.ok(beforeKill.length > 0, `expected partial files mid-download, saw ${beforeKill}`)
      videoId = 'aqz-KE-bpKQ'

      killTree(child)
      await new Promise<void>((resolve) => child.on('close', () => resolve()))

      await cleanupPartials(dir, videoId, startedAt)

      const left = (await readdir(dir)).filter((f) => PARTIAL.test(f))
      assert.deepEqual(left, [], `partial files survived cancel: ${left.join(', ')}`)

      // And nothing of the download tree is still running.
      assert.notEqual(child.exitCode === null && child.signalCode === null, true)
    })
  }
)

/* -- Slowed + reverb ------------------------------------------------------ */

test('fx inputs are clamped and progress parses', () => {
  assert.equal(clampSpeed(0.85), 0.85)
  assert.equal(clampSpeed(3), 1)
  assert.equal(clampSpeed(0.01), 0.5)
  assert.equal(clampSpeed(Number.NaN), 0.85)
  assert.equal(clampReverb(2), 1)
  assert.equal(clampReverb(-1), 0)

  // Output is the source stretched by the speed change, plus the reverb tail.
  assert.equal(expectedDuration(60, 0.5), 123)
  assert.equal(expectedDuration(0, 1), 3)

  assert.equal(parseFfmpegProgress('out_time_us=2500000'), 2.5)
  // ffmpeg emits the same microsecond value under both keys, so out_time_ms must
  // NOT be divided by 1000 — that pinned the bar at 100% instantly.
  assert.equal(parseFfmpegProgress('out_time_ms=2500000'), 2.5)
  assert.equal(parseFfmpegProgress('out_time_us=-1'), null)
  assert.equal(parseFfmpegProgress('progress=continue'), null)
  assert.equal(parseFfmpegProgress('bitrate= 320.0kbits/s'), null)
})

test('progress parsing matches what ffmpeg actually emits', { timeout: 120_000 }, async () => {
  await withTempDir(async (dir) => {
    const src = path.join(dir, 'src.mp3')
    const out = path.join(dir, 'out.mp3')
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=f=440:d=6:r=44100',
      '-c:a', 'libmp3lame', '-b:a', '320k', src
    ])

    const { stdout } = await run(
      ffmpeg,
      [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', src,
        '-filter_complex', buildFilterComplex(44100, 0.85, 0.35),
        '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '320k',
        '-progress', 'pipe:1', '-nostats', out
      ],
      { maxBuffer: 8 * 1024 * 1024 }
    )

    const seconds = stdout
      .split(/\r?\n/)
      .map(parseFfmpegProgress)
      .filter((s): s is number => s !== null)

    assert.ok(seconds.length > 0, 'ffmpeg emitted no parseable progress')
    // Monotonic, and lands on the real output length rather than 1000x past it.
    const expected = expectedDuration(6, 0.85)
    const last = seconds[seconds.length - 1]!
    assert.ok(
      Math.abs(last - expected) < 0.25,
      `final progress ${last}s should match the ${expected.toFixed(2)}s output`
    )
    for (let i = 1; i < seconds.length; i++) {
      assert.ok(seconds[i]! >= seconds[i - 1]!, 'progress went backwards')
    }
  })
})

test('filter chain slows by resampling, never by atempo, and never recodes video', () => {
  const chain = buildFilterComplex(44100, 0.85, 0.35)
  // asetrate drops pitch with tempo; atempo would hold pitch, which is wrong here.
  assert.match(chain, /asetrate=37485/)
  assert.ok(!chain.includes('atempo'), 'atempo would preserve pitch')
  assert.match(chain, /afir=/)
  assert.match(chain, /amix=inputs=2:normalize=0/)
  assert.match(chain, /alimiter/)

  // reverb 0 must zero the wet bus outright, not merely quieten it.
  assert.match(buildFilterComplex(44100, 0.9, 0), /volume=0\.0000/)
  assert.match(buildFilterComplex(48000, 0.75, 1), /asetrate=36000/)
})

test(
  'rendering a real file slows it, adds a measurable tail, and does not clip',
  { timeout: 180_000 },
  async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, 'src.mp3')
      const dry = path.join(dir, 'dry.mp3')
      const wet = path.join(dir, 'wet.mp3')

      // Plucks separated by silence, so a reverb tail is measurable in the gaps.
      await run(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'sine=f=440:d=6:r=44100',
        '-af', "volume='if(lt(mod(t,2),0.15),1,0)':eval=frame,aformat=channel_layouts=stereo",
        '-c:a', 'libmp3lame', '-b:a', '320k', src
      ])

      const render = async (out: string, reverb: number): Promise<void> => {
        await run(ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
          '-filter_complex', buildFilterComplex(44100, 0.85, reverb),
          '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '320k', out
        ], { maxBuffer: 8 * 1024 * 1024 })
      }
      await render(dry, 0)
      await render(wet, 0.35)

      const durationOf = async (f: string): Promise<number> => {
        const { stdout } = await run(ffprobe, [
          '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f
        ])
        return Number(stdout.trim())
      }

      // 6s at 0.85 speed is 7.06s, plus the 3s tail.
      const expected = expectedDuration(6, 0.85)
      const actual = await durationOf(wet)
      assert.ok(
        Math.abs(actual - expected) < 0.25,
        `expected ~${expected.toFixed(2)}s, got ${actual.toFixed(2)}s`
      )

      const measure = async (f: string, args: string[]): Promise<number> => {
        // volumedetect reports on stderr at info level.
        const { stderr } = await run(
          ffmpeg,
          ['-hide_banner', '-nostats', ...args, '-i', f, '-af', 'volumedetect', '-f', 'null', '-'],
          { maxBuffer: 8 * 1024 * 1024 }
        )
        const m = /mean_volume:\s*(-?[\d.]+) dB[\s\S]*?max_volume:\s*(-?[\d.]+) dB/.exec(stderr)
        assert.ok(m, `no volumedetect output for ${f}`)
        return args.length ? Number(m![1]) : Number(m![2])
      }

      const gapArgs = ['-ss', '2.9', '-t', '0.4']
      const dryGap = await measure(dry, gapArgs)
      const wetGap = await measure(wet, gapArgs)

      // The gap is silent without reverb and clearly ringing with it.
      assert.ok(dryGap < -80, `dry gap should be silent, was ${dryGap} dB`)
      assert.ok(
        wetGap > dryGap + 20,
        `reverb tail should lift the gap well above silence: dry ${dryGap} / wet ${wetGap} dB`
      )

      // And the limiter keeps the result under full scale.
      const wetPeak = await measure(wet, [])
      assert.ok(wetPeak < 0, `output should not clip, peak was ${wetPeak} dBFS`)
    })
  }
)

test('fx errors become something a human can act on', () => {
  assert.match(mapFxError('No such file or directory', 1), /moved or renamed/)
  assert.match(mapFxError('Invalid data found when processing input', 1), /not audio/)
  assert.match(mapFxError('Permission denied', 1), /output folder/)
  assert.match(mapFxError('', 137), /exit code 137/)
})

test('cleanupPartials only touches this download and never finished files', async () => {
  await withTempDir(async (dir) => {
    const { writeFile } = await import('node:fs/promises')
    const files = [
      'Mine [aaa111].mp4.part',
      'Mine [aaa111].f299.mp4',
      'Mine [aaa111].mp4.ytdl',
      'Mine [aaa111].mp4.part-Frag12',
      'Mine [aaa111].mp4', // finished — must survive
      'Someone else [bbb222].mp4.part', // another row — must survive
      'holiday.mp4'
    ]
    await Promise.all(files.map((f) => writeFile(path.join(dir, f), 'x')))

    await cleanupPartials(dir, 'aaa111', Date.now())

    const left = (await readdir(dir)).sort()
    assert.deepEqual(left, [
      'Mine [aaa111].mp4',
      'Someone else [bbb222].mp4.part',
      'holiday.mp4'
    ])
  })
})
