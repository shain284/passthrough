#!/usr/bin/env node
/**
 * Generates build/icon.png — a 512px rounded square with a download arrow.
 * Written by hand so the repo needs no image toolchain or binary asset in git.
 */
import { deflateSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const SIZE = 512
const root = path.resolve(import.meta.dirname, '..')

const BG = [0x16, 0x18, 0x1d]
const ACCENT = [0x4f, 0x8c, 0xff]

const px = new Uint8Array(SIZE * SIZE * 4)

/** Signed distance to a rounded rectangle, for cheap anti-aliasing. */
function roundRectSdf(x, y, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(x - cx) - (halfW - r)
  const qy = Math.abs(y - cy) - (halfH - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

function coverage(sdf) {
  // 1 inside, 0 outside, linear across a one-pixel band.
  return Math.min(1, Math.max(0, 0.5 - sdf))
}

function blend(i, rgb, alpha) {
  if (alpha <= 0) return
  const a = Math.min(1, alpha)
  for (let c = 0; c < 3; c++) {
    px[i + c] = Math.round(px[i + c] * (1 - a) + rgb[c] * a)
  }
  px[i + 3] = Math.round(px[i + 3] * (1 - a) + 255 * a)
}

const cx = SIZE / 2
const cy = SIZE / 2

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4
    const fx = x + 0.5
    const fy = y + 0.5

    blend(i, BG, coverage(roundRectSdf(fx, fy, cx, cy, 236, 236, 112)))

    // Arrow shaft.
    blend(i, ACCENT, coverage(roundRectSdf(fx, fy, cx, 216, 34, 92, 16)))

    // Arrow head: an inverted triangle, as three half-plane distances.
    const hw = 122
    const top = 268
    const tip = 392
    const dTop = top - fy
    const left = (fy - top) / (tip - top) // 0 at the top edge, 1 at the tip
    const dSide = Math.abs(fx - cx) - hw * (1 - left)
    const dBottom = fy - tip
    blend(i, ACCENT, coverage(Math.max(dTop, dSide, dBottom)))

    // Baseline under the arrow.
    blend(i, ACCENT, coverage(roundRectSdf(fx, fy, cx, 432, 150, 19, 19)))
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([len, body, crc])
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0 // filter: none
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1)
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const out = path.join(root, 'build', 'icon.png')
await mkdir(path.dirname(out), { recursive: true })
await writeFile(out, png)
process.stdout.write(`wrote ${out} (${png.length} bytes)\n`)
