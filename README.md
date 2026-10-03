# Passthrough

A free Windows app for grabbing and reworking video and audio for edits. Four tabs:

- **Download** — paste a YouTube or TikTok link, save it as MP4 or audio, at the original quality.
- **Slowed + Reverb** — drop in a song, get a slowed, reverbed MP3 back.
- **Stretch** — reframe a video to 9:16, 1:1, 4:5 or 16:9.
- **Upscale** — sharpen up older anime clips 2–4× with an AI model.

Everything runs on your own computer. No account, no sign-up, nothing uploaded anywhere.

## Download

### **[⬇ Download Passthrough-Setup.exe](../../releases/latest/download/Passthrough-Setup.exe)**

Windows 10 or 11, 64-bit. About 220 MB. There is no Mac or Linux version.

1. **Click the link above.** If your browser says the file "isn't commonly downloaded", choose **Keep** (in Edge: click the **…** next to it, then **Keep**, then **Keep anyway**).
2. **Open the downloaded file.** Windows will show a blue box saying *"Windows protected your PC"* with only a **Don't run** button. Click **More info**, then **Run anyway**.
3. **Click Install.** No administrator password is needed.
4. **Open Passthrough** from your desktop or Start menu.

Why the warnings: the app isn't code-signed. A signing certificate costs a few hundred dollars a year, and this is a free personal project, so Windows treats it as unknown. If you'd rather not take a stranger's word for it, the full source is in this repository and you can build it yourself (see below).

All versions, with release notes, are on the [releases page](../../releases).

## Using it

| Tab | How |
|---|---|
| **Download** | Paste a link (it auto-fills if one is on your clipboard), pick **MP4**, **Audio**, **MP3 320** or **MP3 V0**, hit **Download**. MP4 and Audio keep the original quality untouched; the MP3 buttons convert. |
| **Slowed + Reverb** | Drag audio files onto the box (or click it), set **Speed** and **Reverb**, and it renders straight away. Slowing lowers the pitch too, like playing a record slower. |
| **Stretch** | Pick a shape (9:16 for phone), pick how to fit it — **Stretch** squeezes, **Fill** crops the sides, **Fit** adds black bars, **Blur** fills with a blurred copy — then drop a video in. |
| **Upscale** | Pick **2×**, drop a clip in. This is slow: roughly 4 minutes per 30 seconds of footage on a laptop. Made for clips, not whole episodes. |

Files save to your **Downloads** folder. Click **Change** at the bottom of any tab to pick a different one.

## If something goes wrong

- **YouTube downloads failing?** Open **Help → Check for Updates**. YouTube changes how it serves video every few weeks, and this updates the part of the app that keeps up with it. This fixes most problems.
- **Age-restricted or sign-in-only videos** need the **Use browser cookies** box, which borrows your Chrome login. Recent versions of Chrome lock their cookies in a way the app can't read, so this often won't work. If you see an error about Chrome cookies, turn the box back off.
- **Upscale fails straight away?** It needs a graphics card with Vulkan support, which almost every PC from the last several years has. Updating your graphics driver usually fixes it.
- **Anything else:** **Help → Open Log File** shows exactly what went wrong.

**Updating:** download the new installer from the link above and run it over the top. Your settings are kept.

There is also a [portable version](../../releases/latest/download/Passthrough-Portable.exe) that runs without installing. Use the installer if you can: the portable one unpacks itself fresh every time it opens, so **Check for Updates** can't stick.

---

## The no-re-encoding claim

Only the Download tab makes it, and it holds:

- MP4 merges are a stream copy. If the best video is VP9 or AV1 in webm, it remuxes to MP4 with `-c copy` rather than dropping to a worse MP4-native format. `--recode-video` appears nowhere. If a stream refuses to remux, it keeps the MKV and says so instead of transcoding.
- **Audio (original)** passes the source bytes through untouched. Verified by comparing the audio-stream MD5 of the output against the raw source — identical.
- The MP3 buttons *do* re-encode, and the app says so.

The other three tabs are renders, not copies. Slowing and reverb, scaling and cropping, and neural upscaling all touch every sample and every pixel; there's no `-c copy` path for any of them, and each tab says so plainly. Stretch and Upscale still copy the **audio** untouched whenever MP4 can hold the codec.

yt-dlp tracks the **nightly** channel rather than stable. YouTube changes its player every few weeks and the fixes land in nightly first; a stable build six weeks old was 403-ing partway through downloads that nightly handled without complaint.

## About the Upscale tab

It runs Real-ESRGAN's `realesr-animevideov3` model on the GPU via Vulkan, which reconstructs line art and flat colour rather than just enlarging pixels — well suited to older cel animation, much less so to live action.

Speed depends entirely on the GPU. Measured on an integrated Radeon 780M at 640×480: **~3 fps at 2×**. A discrete card is typically 10–20× faster.

Frames are processed in chunks of 300 rather than all at once. Extracting a whole episode's frames at 4× would need ~190 GB of intermediate PNGs; chunking holds scratch space to a couple of GB regardless of input length, and the scratch directory is removed on completion, cancel, or quit. Only one upscale runs at a time, and the ETA switches from an estimate to the measured rate once the first chunk lands.

## Building it yourself

```bash
npm install
npm run binaries -- --with-deno
npm run build
npm run pack:win
```

The sidecars — `yt-dlp` (nightly), `ffmpeg`, `ffprobe`, Real-ESRGAN with its anime models, and optionally `deno` — aren't committed. They're large, they change often, and yt-dlp self-updates in place. `npm run binaries` fetches them into `resources/bin/<platform>/`.

`deno` is optional but recommended. yt-dlp has deprecated YouTube extraction without a JavaScript runtime and only auto-detects deno; without one, some videos silently yield fewer formats. Drop `-- --with-deno` to skip it and save about 100 MB.

```bash
npm test        # integration tests, needs the binaries and a network
npm run typecheck
npm run dev
```

The tests are real: they cancel a live download and assert no `.part` files survive, render audio and measure the reverb tail, reframe video and check the output's dimensions and audio MD5, upscale across chunk boundaries and assert zero frame drift, and pin the render queue's concurrency limit.

## How it's put together

- `src/main/` — Electron main. Owns every `spawn`, the queues, and the filesystem.
- `src/preload/` — `contextBridge` only. `contextIsolation: true`, `nodeIntegration: false`.
- `src/renderer/` — React. No Node APIs.

Arguments are always passed to `spawn` as an array — never `shell: true`, never string interpolation. Pasted URLs are checked against a host allowlist before they reach yt-dlp, and dropped file paths are re-validated in the main process rather than trusted from the renderer.

Raw `yt-dlp` and `ffmpeg` output goes to a log file, openable from the Help menu, and stays out of the UI.

## Scope

It does the four things above and nothing else. No accounts, no cloud sync, no settings page with twelve toggles.

Downloading media you don't have the rights to may breach a site's terms or your local law. That's on you.

## Licence

MIT — see [LICENSE](LICENSE). Bundled at runtime but not included in this repo: [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense), [FFmpeg](https://ffmpeg.org/) (GPL build), [Deno](https://deno.com/) (MIT), [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) (BSD-3-Clause).
