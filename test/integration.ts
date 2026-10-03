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
import { mkdir, readdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { ASPECT_IDS, FIT_MODE_IDS } from '../src/shared/types.ts'
import { buildDownloadArgs, FILE_PREFIX, POSTPROCESS_PREFIX } from '../src/main/formats.ts'
import { MediaQueue } from '../src/main/mediaqueue.ts'
import {
  buildExtractArgs,
  buildJoinArgs,
  buildSegmentArgs,
  buildUpscaleArgs,
  mapUpscaleError,
  parseUpscalePercent,
  planChunks,
  upscaledSize
} from '../src/main/upscale.ts'
import {
  audioArgs,
  buildStretchArgs,
  buildVideoFilter,
  isAudioCopied,
  mapStretchError,
  outputSize
} from '../src/main/stretch.ts'
import { parseProgressLine } from '../src/main/progress.ts'
import { cleanupPartials, killTree } from '../src/main/proc.ts'
import { isRemuxFailure, mapError } from '../src/main/errors.ts'
import { normalizeUrl } from '../src/main/urls.ts'

const binDir = path.resolve(import.meta.dirname, '..', 'resources', 'bin', process.platform)
const exe = process.platform === 'win32' ? '.exe' : ''
const ytDlp = path.join(binDir, `yt-dlp${exe}`)
const ffmpeg = path.join(binDir, `ffmpeg${exe}`)
const ffprobe = path.join(binDir, `ffprobe${exe}`)
const realesrgan = path.join(binDir, `realesrgan-ncnn-vulkan${exe}`)
const modelDirPath = path.join(binDir, 'models')
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
    ['ERROR: [youtube] x: HTTP Error 429: Too Many Requests', 'retry'],
    // A 403 partway through a transfer means a stale extractor, not a bad video,
    // so the row must offer the update rather than a pointless retry.
    ['ERROR: unable to download video data: HTTP Error 403: Forbidden', 'update-ytdlp'],
    // Chrome's app-bound encryption: closing Chrome does not help, so the row
    // must not suggest it.
    ['ERROR: Failed to decrypt with DPAPI. See  https://github.com/yt-dlp/yt-dlp/issues/10927', 'none']
  ]
  for (const [stderr, action] of cases) {
    const mapped = mapError(stderr, 1)
    assert.equal(mapped.action, action, `${stderr} -> ${mapped.action}`)
    assert.ok(mapped.message.length > 0)
    assert.ok(!mapped.message.includes('ERROR:'), 'raw yt-dlp prefix must not reach the UI')
  }

  // Unknown errors still surface something specific rather than a shrug.
  assert.match(mapError('ERROR: something entirely new happened', 1).message, /something entirely new/)

  // The DPAPI advice must point at something the app can actually do — it only
  // reads Chrome, so suggesting another browser would be a dead end.
  const dpapi = mapError('ERROR: Failed to decrypt with DPAPI', 1)
  assert.match(dpapi.message, /off/)
  assert.ok(!/firefox/i.test(dpapi.message), 'the app has no Firefox option to switch to')
  assert.ok(!/close/i.test(dpapi.message), 'closing Chrome does not fix app-bound encryption')

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

/* -- Aspect ratio stretcher ----------------------------------------------- */

test('output size keeps the pixel count and lands on the expected frames', () => {
  // 1080p to a phone is exactly 1080x1920 — no invented detail, no downscale.
  assert.deepEqual(outputSize({ width: 1920, height: 1080 }, '9:16'), {
    width: 1080,
    height: 1920
  })
  assert.deepEqual(outputSize({ width: 3840, height: 2160 }, '9:16'), {
    width: 2160,
    height: 3840
  })
  // Same aspect in and out must be a no-op, not a resample.
  assert.deepEqual(outputSize({ width: 1920, height: 1080 }, '16:9'), {
    width: 1920,
    height: 1080
  })
  assert.deepEqual(outputSize({ width: 1920, height: 1080 }, '1:1'), {
    width: 1440,
    height: 1440
  })

  // H.264 in yuv420p needs both dimensions even, whatever the source.
  for (const src of [
    { width: 1919, height: 1079 },
    { width: 641, height: 361 },
    { width: 100, height: 3 }
  ]) {
    for (const aspect of ASPECT_IDS) {
      const out = outputSize(src, aspect)
      assert.equal(out.width % 2, 0, `${src.width}x${src.height} ${aspect} width odd`)
      assert.equal(out.height % 2, 0, `${src.width}x${src.height} ${aspect} height odd`)
      assert.ok(out.width >= 2 && out.height >= 2)
    }
  }
})

test('each fit mode does what its name says', () => {
  const out = { width: 1080, height: 1920 }

  // Stretch distorts: a plain scale with no aspect preservation at all.
  const stretch = buildVideoFilter('stretch', out)
  assert.match(stretch, /scale=1080:1920:flags=lanczos/)
  assert.ok(!stretch.includes('force_original_aspect_ratio'))
  assert.ok(!stretch.includes('crop='))

  // Fill covers then trims the overflow.
  const crop = buildVideoFilter('crop', out)
  assert.match(crop, /force_original_aspect_ratio=increase/)
  assert.match(crop, /crop=1080:1920/)

  // Fit shrinks to contain, then fills the gap with black.
  const pad = buildVideoFilter('pad', out)
  assert.match(pad, /force_original_aspect_ratio=decrease/)
  assert.match(pad, /pad=1080:1920/)

  // Blur needs both: a cover for the backdrop and a contain for the sharp copy.
  const blur = buildVideoFilter('blur', out)
  assert.match(blur, /force_original_aspect_ratio=increase/)
  assert.match(blur, /force_original_aspect_ratio=decrease/)
  assert.match(blur, /gblur=sigma=\d+/)
  assert.match(blur, /overlay=\(W-w\)\/2:\(H-h\)\/2/)

  // Every mode must clear SAR, or a player re-stretches what we just framed.
  for (const mode of FIT_MODE_IDS) {
    assert.match(buildVideoFilter(mode, out), /setsar=1/, `${mode} must set SAR`)
    assert.match(buildVideoFilter(mode, out), /\[vout\]$/, `${mode} must end in [vout]`)
  }
})

test('audio is copied whenever MP4 can hold it', () => {
  for (const codec of ['aac', 'mp3', 'AAC', 'alac', 'ac3']) {
    assert.deepEqual(audioArgs(codec), ['-c:a', 'copy'], `${codec} should be copied`)
    assert.equal(isAudioCopied(codec), true)
  }
  // Opus and vorbis are not safely muxable here, so they get converted.
  for (const codec of ['opus', 'vorbis', 'pcm_s16le']) {
    assert.deepEqual(audioArgs(codec), ['-c:a', 'aac', '-b:a', '192k'])
    assert.equal(isAudioCopied(codec), false)
  }
  assert.deepEqual(audioArgs(null), [])
  assert.equal(isAudioCopied(null), false)
})

test('stretch args never downscale-by-default and always re-encode video once', () => {
  const args = buildStretchArgs({
    input: '/in.mp4',
    output: '/out.mp4',
    source: { width: 1920, height: 1080 },
    aspect: '9:16',
    mode: 'crop',
    audioCodec: 'aac'
  })
  assert.ok(args.includes('libx264'))
  assert.ok(args.includes('-crf') && args.includes('17'))
  assert.ok(args.includes('yuv420p'))
  assert.ok(args.includes('+faststart'))
  // Audio copied, so only the video is touched.
  assert.ok(args.join(' ').includes('-c:a copy'))
  // A silent source must not fail the render.
  assert.ok(args.join(' ').includes('-map 0:a:0?'))
  assert.equal(args.at(-1), '/out.mp4')
})

test('stretch errors become something a human can act on', () => {
  assert.match(mapStretchError('No such file or directory', 1), /moved or renamed/)
  assert.match(mapStretchError('moov atom not found', 1), /not video/)
  assert.match(mapStretchError('No space left on device', 1), /out of space/)
  assert.match(mapStretchError('', 137), /exit code 137/)
})

test(
  'reframing a real video hits the target shape, keeps SAR square and copies the audio',
  { timeout: 300_000 },
  async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, 'src.mp4')
      await run(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=3',
        '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=3',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-shortest', src
      ])

      const audioMd5 = async (f: string): Promise<string> => {
        const { stdout } = await run(ffmpeg, [
          '-v', 'error', '-i', f, '-map', '0:a:0', '-c', 'copy', '-f', 'md5', '-'
        ])
        return stdout.trim()
      }
      const sourceAudio = await audioMd5(src)

      for (const mode of FIT_MODE_IDS) {
        const out = path.join(dir, `${mode}.mp4`)
        await run(
          ffmpeg,
          buildStretchArgs({
            input: src,
            output: out,
            source: { width: 1920, height: 1080 },
            aspect: '9:16',
            mode,
            audioCodec: 'aac'
          }),
          { maxBuffer: 16 * 1024 * 1024 }
        )

        const { stdout } = await run(ffprobe, [
          '-v', 'error', '-select_streams', 'v:0',
          '-show_entries', 'stream=width,height,sample_aspect_ratio,pix_fmt',
          '-of', 'csv=p=0', out
        ])
        const [w, h, sar, fmt] = stdout.trim().split(',')
        assert.equal(w, '1080', `${mode} width`)
        assert.equal(h, '1920', `${mode} height`)
        // Anything but 1:1 means the player would stretch it again on playback.
        assert.ok(sar === '1:1' || sar === 'N/A', `${mode} SAR was ${sar}`)
        assert.equal(fmt, 'yuv420p', `${mode} pixel format`)

        // The whole point of copying the audio: it must survive bit for bit.
        assert.equal(await audioMd5(out), sourceAudio, `${mode} altered the audio`)
      }
    })
  }
)

/* -- Neural upscaler ------------------------------------------------------ */

test('chunk planning covers every frame exactly once', () => {
  assert.deepEqual(planChunks(10, 4), [
    { index: 0, startFrame: 0, frameCount: 4 },
    { index: 1, startFrame: 4, frameCount: 4 },
    { index: 2, startFrame: 8, frameCount: 2 }
  ])
  assert.deepEqual(planChunks(0, 4), [])

  // Whatever the size, the parts must sum to the whole with no overlap.
  for (const [total, size] of [[1, 300], [300, 300], [301, 300], [7919, 64]]) {
    const chunks = planChunks(total!, size!)
    assert.equal(
      chunks.reduce((n, c) => n + c.frameCount, 0),
      total,
      `${total}/${size} frames do not sum`
    )
    chunks.forEach((c, i) => {
      if (i > 0) {
        const prev = chunks[i - 1]!
        assert.equal(c.startFrame, prev.startFrame + prev.frameCount, 'gap or overlap')
      }
    })
  }
})

test('upscaled size multiplies both dimensions and stays even', () => {
  assert.deepEqual(upscaledSize({ width: 640, height: 480 }, 2), { width: 1280, height: 960 })
  assert.deepEqual(upscaledSize({ width: 640, height: 480 }, 4), { width: 2560, height: 1920 })
  // Odd sources must not produce odd output — yuv420p cannot encode it.
  for (const f of [2, 3, 4] as const) {
    const out = upscaledSize({ width: 353, height: 241 }, f)
    assert.equal(out.width % 2, 0)
    assert.equal(out.height % 2, 0)
  }
})

test('upscale progress percentages parse and noise is ignored', () => {
  assert.equal(parseUpscalePercent('12.50%'), 12.5)
  assert.equal(parseUpscalePercent('  100.00%  '), 100)
  assert.equal(parseUpscalePercent('0%'), 0)
  assert.equal(parseUpscalePercent('vkAllocateMemory failed'), null)
  assert.equal(parseUpscalePercent('120%'), null)
  assert.equal(parseUpscalePercent(''), null)
})

test('upscale args seek per chunk and never resample the audio needlessly', () => {
  const extract = buildExtractArgs({
    input: '/in.mp4', startFrame: 600, frameCount: 300, fps: 24, outDir: '/tmp/x'
  })
  // Seek must come before -i or ffmpeg decodes and throws away everything prior.
  assert.ok(extract.indexOf('-ss') < extract.indexOf('-i'), '-ss must precede -i')
  assert.ok(extract.includes('25.000000'), '600 frames at 24fps is 25s')
  assert.ok(extract.includes('passthrough'), 'must not resample the frame rate')

  const model = buildUpscaleArgs({
    inDir: '/a', outDir: '/b', factor: 3, modelDir: '/m'
  })
  assert.ok(model.includes('realesr-animevideov3'))
  assert.ok(model.includes('-s') && model.includes('3'))
  // Model dir must be explicit; the exe otherwise looks next to its own cwd.
  assert.ok(model.includes('-m') && model.includes('/m'))

  const join = buildJoinArgs({
    listFile: '/l.txt', original: '/in.mp4', output: '/out.mp4', audioCodec: 'aac'
  })
  // Segments are already encoded — joining must copy, not re-encode.
  assert.ok(join.join(' ').includes('-c:v copy'))
  assert.ok(join.join(' ').includes('-c:a copy'))
  assert.ok(join.join(' ').includes('-map 1:a:0?'))
})

test('upscale errors name the actual cause', () => {
  assert.match(mapUpscaleError('vkCreateInstance failed', 1), /Vulkan/)
  assert.match(mapUpscaleError('vkAllocateMemory out of memory', 1), /GPU ran out of memory/)
  assert.match(mapUpscaleError('No space left on device', 1), /disk space/)
  assert.match(mapUpscaleError('failed to load model', 1), /model failed to load/)
  // A bare percentage is progress noise, not an error message.
  assert.match(mapUpscaleError('50.00%\n', 1), /exit code 1/)
})

test(
  'chunked upscaling loses no frames and keeps duration exact',
  { timeout: 600_000 },
  async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, 'src.mp4')
      // Small and short so this stays a test rather than a render job.
      await run(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=2',
        '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=2',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest', src
      ])

      const CHUNK = 20 // forces multiple chunks out of 48 frames
      const segments: string[] = []
      let extractedTotal = 0

      for (let index = 0; ; index++) {
        const srcDir = path.join(dir, `s${index}`)
        const upDir = path.join(dir, `u${index}`)
        await mkdir(srcDir); await mkdir(upDir)

        await run(ffmpeg, buildExtractArgs({
          input: src, startFrame: index * CHUNK, frameCount: CHUNK, fps: 24, outDir: srcDir
        }))
        const got = (await readdir(srcDir)).length
        if (got === 0) break
        extractedTotal += got

        await run(realesrgan, buildUpscaleArgs({
          inDir: srcDir, outDir: upDir, factor: 2, modelDir: modelDirPath
        }), { maxBuffer: 16 * 1024 * 1024 })
        assert.equal((await readdir(upDir)).length, got, `chunk ${index} lost frames`)

        const seg = path.join(dir, `seg${String(index).padStart(5, '0')}.mp4`)
        await run(ffmpeg, buildSegmentArgs({ frameDir: upDir, fps: 24, output: seg }))
        segments.push(seg)
        if (got < CHUNK) break
      }

      assert.ok(segments.length > 1, 'test must exercise the multi-chunk path')

      const listFile = path.join(dir, 'list.txt')
      await writeFile(
        listFile,
        segments.map((s) => `file '${s.replace(/\\/g, '/')}'`).join('\n'),
        'utf8'
      )
      const out = path.join(dir, 'out.mp4')
      await run(ffmpeg, buildJoinArgs({
        listFile, original: src, output: out, audioCodec: 'aac'
      }))

      const probe = async (f: string): Promise<string> => {
        const { stdout } = await run(ffprobe, [
          '-v', 'error', '-select_streams', 'v:0',
          '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames',
          '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f
        ], { maxBuffer: 8 * 1024 * 1024 })
        return stdout.trim()
      }
      const [sw, sh, sFrames, sDur] = (await probe(src)).split(/\s+/)
      const [ow, oh, oFrames, oDur] = (await probe(out)).split(/\s+/)

      assert.equal(Number(ow), Number(sw) * 2, 'width must double')
      assert.equal(Number(oh), Number(sh) * 2, 'height must double')
      assert.equal(Number(oFrames), Number(sFrames), 'frame drift across chunks')
      assert.equal(extractedTotal, Number(sFrames), 'extraction lost or duplicated frames')
      assert.ok(
        Math.abs(Number(oDur) - Number(sDur)) < 0.05,
        `duration drifted: ${sDur} -> ${oDur}`
      )
    })
  }
)

/* -- Render queue scheduling ---------------------------------------------- */

test('the render queue never runs more than its limit, even while probing', async () => {
  // The bug this pins: start() awaits a probe before the child process exists,
  // so a queue that counts spawned children instead of claimed rows will launch
  // every queued row at once.
  interface Row {
    id: string
    status: 'queued' | 'rendering' | 'done' | 'error' | 'canceled'
  }

  let peak = 0
  let running = 0
  const finishers: (() => void)[] = []

  class TestQueue extends MediaQueue<Row> {
    protected readonly maxConcurrent = 2
    protected retryPatch(): Partial<Row> {
      return {}
    }
    protected async startItem(id: string): Promise<void> {
      this.patch(id, { status: 'rendering' })
      // Stand-in for probeAudio/probeVideo: a real await before any child exists.
      await new Promise((r) => setTimeout(r, 5))
      if (this.get(id)?.status !== 'rendering') return
      running++
      peak = Math.max(peak, running)
      this.registerJob(id, { kill: () => undefined, cleanup: async () => undefined })
      finishers.push(() => {
        running--
        this.clearJob(id)
        this.patch(id, { status: 'done' })
        this.pump()
      })
    }
    seed(n: number): void {
      for (let i = 0; i < n; i++) this.append({ id: `row-${i}`, status: 'queued' })
      this.pump()
    }
  }

  const q = new TestQueue()
  q.seed(8)

  // Let every pending start() settle, then drain, repeatedly.
  for (let guard = 0; guard < 50 && q.list().some((r) => r.status !== 'done'); guard++) {
    await new Promise((r) => setTimeout(r, 15))
    while (finishers.length) finishers.shift()!()
  }

  assert.equal(peak, 2, `expected at most 2 concurrent renders, peaked at ${peak}`)
  assert.equal(q.list().filter((r) => r.status === 'done').length, 8)
})

test('the render queue cancels a row that is still probing', async () => {
  interface Row {
    id: string
    status: 'queued' | 'rendering' | 'done' | 'error' | 'canceled'
  }
  let spawned = 0

  class TestQueue extends MediaQueue<Row> {
    protected readonly maxConcurrent = 2
    protected retryPatch(): Partial<Row> {
      return {}
    }
    protected async startItem(id: string): Promise<void> {
      this.patch(id, { status: 'rendering' })
      await new Promise((r) => setTimeout(r, 20))
      // Cancelled mid-probe: nothing should be launched.
      if (this.get(id)?.status !== 'rendering') return
      spawned++
      this.registerJob(id, { kill: () => undefined, cleanup: async () => undefined })
    }
    seed(): void {
      this.append({ id: 'a', status: 'queued' })
      this.pump()
    }
  }

  const q = new TestQueue()
  q.seed()
  q.cancel('a')
  assert.equal(q.get('a')?.status, 'canceled')
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(spawned, 0, 'a cancelled row must not spawn a process')
  assert.equal(q.get('a')?.status, 'canceled')
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
