# Passthrough

A local desktop app for sourcing and reframing media. Three tabs:

- **Download** — paste a YouTube or TikTok link, save it as MP4 or audio. The video stream is never re-encoded.
- **Slowed + Reverb** — drop audio in, get a slowed, pitched-down, reverbed MP3 out.
- **Stretch** — drop video in, reframe it to 9:16, 1:1, 4:5 or 16:9.
- **Upscale** — drop a clip in, upscale it 2–4× with Real-ESRGAN's anime model.

Everything runs on your machine. No account, no server, no telemetry.

## Install

Grab `Passthrough-<version>-Setup.exe` from the [latest release](../../releases/latest). 64-bit Windows.

**Windows will warn you.** The build isn't code-signed, so SmartScreen shows a blue "Windows protected your PC" box with only a *Don't run* button. Click **More info → Run anyway**. Signing certificates cost a few hundred a year and this is a personal tool, so unsigned is expected — but you're trusting a stranger's binary, so read the source or build it yourself if you'd rather not.

It installs per-user to `%LOCALAPPDATA%\Programs\Passthrough`, no admin prompt.

There's also a portable build. Prefer the installer: the portable one re-extracts to a temp folder on every launch, so **Help → Check for Updates** updates a copy that's discarded on exit.

## The no-re-encoding claim

Only the Download tab can honestly make it, and it does:

- MP4 merges are a stream copy. If the best video is VP9 or AV1 in webm, it remuxes to MP4 with `-c copy` rather than dropping to a worse MP4-native format. `--recode-video` appears nowhere. If a stream refuses to remux, it keeps the MKV and says so instead of transcoding.
- **Audio (original)** passes the source bytes through untouched. Verified by comparing the audio-stream MD5 of the output against the raw source — identical.
- The MP3 buttons *do* re-encode, and the UI says so.

The other three tabs are renders, not copies. Slowing and convolution reverb, scaling and cropping, or neural upscaling all touch every sample and every pixel; there's no `-c copy` path for any of them. Each tab says so plainly. Stretch and Upscale do still copy the **audio** untouched whenever MP4 can hold the codec.

## About the Upscale tab

It runs Real-ESRGAN's `realesr-animevideov3` model on the GPU via Vulkan, which reconstructs line art and flat colour rather than just enlarging pixels — well suited to older cel animation, much less so to live action.

It is slow, and how slow depends entirely on your GPU. Measured on an integrated Radeon 780M at 640×480: **~3 fps at 2×**, so roughly four minutes per thirty seconds of footage. A discrete card is typically 10–20× faster. **This tab is built for clips.** A full 24-minute episode is several hours.

Frames are processed in chunks of 300 rather than all at once. Extracting a whole episode's frames at 4× would need ~190 GB of intermediate PNGs; chunking holds scratch space to a couple of GB regardless of input length, and the scratch directory is removed on completion, cancel, or quit.

Only one upscale runs at a time. The GPU is the bottleneck, so running two would just halve each and make both ETAs meaningless. The first ETA is an estimate scaled from that reference measurement; once a chunk completes, the row switches to the rate actually being achieved.

## Building it yourself

```bash
npm install
npm run binaries -- --with-deno
npm run build
npm run pack:win
```

The `yt-dlp`, `ffmpeg`, `ffprobe` and `deno` sidecars aren't committed — they're large, they change often, and yt-dlp self-updates in place. `npm run binaries` fetches them into `resources/bin/<platform>/`.

`deno` is optional but recommended. yt-dlp has deprecated YouTube extraction without a JavaScript runtime and only auto-detects deno; without one, some videos silently yield fewer formats. Drop the `-- --with-deno` to skip it and save about 100 MB.

```bash
npm test        # integration tests, needs the binaries and a network
npm run typecheck
npm run dev
```

The tests are real: they cancel a live download and assert no `.part` files survive, render audio and measure the reverb tail, reframe video and check the output's dimensions and audio MD5, and pin the render queue's concurrency limit.

## How it's put together

- `src/main/` — Electron main. Owns every `spawn`, the queues, and the filesystem.
- `src/preload/` — `contextBridge` only. `contextIsolation: true`, `nodeIntegration: false`.
- `src/renderer/` — React. No Node APIs.

Arguments are always passed to `spawn` as an array — never `shell: true`, never string interpolation. Pasted URLs are checked against a host allowlist before they reach yt-dlp, and dropped file paths are re-validated in the main process rather than trusted from the renderer.

Raw `yt-dlp` and `ffmpeg` output goes to a log file, openable from the Help menu, and stays out of the UI.

## Scope

It does the three things above and nothing else. No accounts, no cloud sync, no settings page with twelve toggles.

Downloading media you don't have the rights to may breach a site's terms or your local law. That's on you.

## Licence

MIT — see [LICENSE](LICENSE). Bundled at runtime but not included in this repo: [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense), [FFmpeg](https://ffmpeg.org/) (GPL build), [Deno](https://deno.com/) (MIT).
