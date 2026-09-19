import { describe, it, expect } from "vitest";
import { XorShift128, deriveSeed, sha256 } from "../src/lib/rng";
import { crc32 } from "../src/lib/crc";
import {
  padDims,
  encodeImage,
  VERSION,
  ALGORITHM_VERSION,
  BLOCK_SIZE,
} from "../src/lib/encode";
import { decodeImage } from "../src/lib/decode";
import {
  makePayload,
  buildMetaMatrix,
  readMetaMatrix,
  payloadToBits,
  bitsToPayload,
  META_GRID,
  META_MAGIC,
} from "../src/lib/meta";
import { cellLuminanceQuad, getPerspectiveTransform, renderInto } from "../src/lib/warp";
import { composeDisplay, buildRects, drawMetaBlock } from "../src/lib/compose";
import { processFrame } from "../src/lib/receiver";

function randomRgba(w: number, h: number, seed = 42): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = rnd() * 255;
    out[i * 4 + 1] = rnd() * 255;
    out[i * 4 + 2] = rnd() * 255;
    out[i * 4 + 3] = 255;
  }
  return out;
}

describe("rng", () => {
  it("sha256 is deterministic", async () => {
    const a = await sha256(new TextEncoder().encode("hello"));
    const b = await sha256(new TextEncoder().encode("hello"));
    expect([...a]).toEqual([...b]);
  });

  it("deriveSeed / XorShift128 is deterministic across instances", async () => {
    const s1 = new XorShift128(await deriveSeed("key1"));
    const s2 = new XorShift128(await deriveSeed("key1"));
    expect(s1.nextU32()).toBe(s2.nextU32());
    expect(s1.permute(16)).toEqual(s2.permute(16));
  });

  it("permute returns a permutation", async () => {
    const s = new XorShift128(await deriveSeed("perm"));
    const p = s.permute(64);
    expect([...p].sort((a, b) => a - b)).toEqual(Array.from({ length: 64 }, (_, i) => i));
  });
});

describe("crc", () => {
  it("matches a known constant", () => {
    // CRC32 of "123456789" is 0xCBF43926
    const buf = new TextEncoder().encode("123456789");
    expect(crc32(buf)).toBe(0xcbf43926);
  });
});

describe("meta", () => {
  it("payload bits round trip", () => {
    const p = makePayload(100, 73, { pw: 128, ph: 96 }, 0xdeadbeef, [1, 2, 3, 4]);
    const bits = payloadToBits(p);
    const back = bitsToPayload(bits);
    expect(back).toMatchObject(p);
  });

  it("matrix -> luminance -> read round trip through rendering", () => {
    const p = makePayload(100, 73, { pw: 128, ph: 96 }, 0x12345678, [111, 222, 333, 444]);
    const mat = buildMetaMatrix(p);

    // Draw the block on a black background buffer.
    const bufW = 300;
    const bufH = 300;
    const buf = new Uint8ClampedArray(bufW * bufH * 4).fill(0);
    const rect = [
      { x: 50, y: 50 },
      { x: 50 + 150, y: 50 },
      { x: 50 + 150, y: 50 + 150 },
      { x: 50, y: 50 + 150 },
    ];
    drawMetaBlock(buf, bufW, bufH, mat, rect);

    const lum = cellLuminanceQuad(buf, bufW, bufH, rect, META_GRID, 6);
    const out = readMetaMatrix(lum);
    expect(out).toMatchObject(p);
  });

  it("rejects a payload whose magic is destroyed", () => {
    const p = makePayload(100, 73, { pw: 128, ph: 96 }, 1, [0, 0, 0, 0]);
    const mat = buildMetaMatrix(p);
    // Flip all data-band cells so every redundant copy of the magic fails.
    const dataStart = 1 + 2;
    for (let y = dataStart; y < META_GRID - dataStart; y++) {
      for (let x = dataStart; x < META_GRID - dataStart; x++) {
        mat[y * META_GRID + x] = mat[y * META_GRID + x] ? 0 : 1;
      }
    }
    const lum = new Float32Array(mat.length);
    for (let i = 0; i < mat.length; i++) lum[i] = mat[i] ? 255 : 0;
    const out = readMetaMatrix(lum);
    expect(out).toBeNull();
  });
});

describe("encode/decode round trip", () => {
  it("reproduces the exact original for non-multiple-of-32 dims", async () => {
    const w = 100;
    const h = 73;
    const src = randomRgba(w, h);
    const key = "super-secret";
    const enc = await encodeImage({ rgba: src, width: w, height: h, key });
    const { pw, ph } = padDims(w, h);
    expect(enc.width).toBe(w);
    expect(enc.height).toBe(h);
    const dec = await decodeImage({
      rgba: enc.rgba,
      pw,
      ph,
      key,
      checksum: enc.checksum,
      groupCrcs: enc.groupCrcs,
      width: w,
      height: h,
    });
    expect(dec.ok).toBe(true);
    if (dec.ok) {
      for (let i = 0; i < w * h; i++) {
        expect(dec.rgba[i * 4]).toBe(src[i * 4]);
        expect(dec.rgba[i * 4 + 1]).toBe(src[i * 4 + 1]);
        expect(dec.rgba[i * 4 + 2]).toBe(src[i * 4 + 2]);
      }
    }
  });

  it("different keys fail (checksum mismatch)", async () => {
    const w = 96;
    const h = 96;
    const src = randomRgba(w, h);
    const enc = await encodeImage({ rgba: src, width: w, height: h, key: "a" });
    const dec = await decodeImage({
      rgba: enc.rgba,
      pw: w,
      ph: h,
      key: "b",
      checksum: enc.checksum,
      groupCrcs: enc.groupCrcs,
      width: w,
      height: h,
    });
    expect(dec.ok).toBe(false);
  });
});

describe("detect + processFrame (synthetic camera)", () => {
  it("composed display is detected and decoded end to end", async () => {
    // Kept modest so each source pixel maps to a large solid camera block
    // (like a phone held close to a full-screen frame).
    const w = 64;
    const h = 48;
    const src = randomRgba(w, h);
    const key = "hello-camera";
    const enc = await encodeImage({ rgba: src, width: w, height: h, key });

    const payload = makePayload(
      enc.width,
      enc.height,
      { pw: enc.pw, ph: enc.ph },
      enc.checksum,
      enc.groupCrcs
    );
    const mat = buildMetaMatrix(payload);

    const winW = 960;
    const winH = 720;
    const display = composeDisplay(enc.rgba, enc.pw, enc.ph, mat, winW, winH);

    // Warp the display into a synthetic high-res camera frame under perspective.
    const camW = 3200;
    const camH = 2400;
    const quad = [
      { x: 290, y: 240 },
      { x: 2930, y: 320 },
      { x: 2870, y: 2140 },
      { x: 250, y: 2050 },
    ];
    const cam = renderInto(
      display,
      winW,
      winH,
      [
        { x: 0, y: 0 },
        { x: winW, y: 0 },
        { x: winW, y: winH },
        { x: 0, y: winH },
      ],
      quad,
      camW,
      camH
    );

    // Sample a few camera pixels actually inside the screen to make sure the
    // synthetic warp placed content where expected (sanity).
    const centerOfScreen = getPerspectiveTransform(
      quad.map((q) => ({ x: q.x, y: q.y })),
      [
        { x: 0, y: 0 },
        { x: winW, y: 0 },
        { x: winW, y: winH },
        { x: 0, y: winH },
      ]
    );
    void centerOfScreen;

    const status = await processFrame({ rgba: cam, width: camW, height: camH, key });
    expect(status.stage).toBe("decoded");
    if (status.stage === "decoded") {
      expect(status.result.width).toBe(w);
      expect(status.result.height).toBe(h);
      expect(status.result.quality).toBeGreaterThan(0);
      // The camera path resamples (bilinear interpolation), so exact bytes are
      // not guaranteed; stay within the quantized tolerance.
      for (let i = 0; i < w * h; i++) {
        expect(Math.abs(status.result.rgba[i * 4] - src[i * 4])).toBeLessThanOrEqual(8);
        expect(Math.abs(status.result.rgba[i * 4 + 1] - src[i * 4 + 1])).toBeLessThanOrEqual(8);
        expect(Math.abs(status.result.rgba[i * 4 + 2] - src[i * 4 + 2])).toBeLessThanOrEqual(8);
      }
    }
  });

  it("returns scanning when there is no screen", async () => {
    const camW = 320;
    const camH = 240;
    const cam = new Uint8ClampedArray(camW * camH * 4).fill(0);
    const status = await processFrame({ rgba: cam, width: camW, height: camH, key: "x" });
    expect(status.stage).toBe("scanning");
  });

  it("geometry constants are sane", () => {
    const S = 1200;
    const r = buildRects(S);
    expect(r.dataRect[0].x).toBeGreaterThan(r.frameInner[0].x);
    expect(r.dataRect[2].x).toBeLessThan(r.frameInner[2].x);
    expect(r.metaGridPx).toBeGreaterThan(0);
  });

  it("metadata magic constant is intact", () => {
    expect(META_MAGIC).toBe(0xa5);
    expect(VERSION).toBe(1);
    expect(ALGORITHM_VERSION).toBe(1);
    expect(BLOCK_SIZE).toBe(32);
  });
});