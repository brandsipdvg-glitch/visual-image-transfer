import { describe, it, expect } from "vitest";
import { encodeImage } from "../src/lib/encode";
import { makePayload, buildMetaMatrix } from "../src/lib/meta";
import { composeDisplay } from "../src/lib/compose";
import { renderInto, applyH, getPerspectiveTransform, solveHomographyLS, matMul3 } from "../src/lib/warp";
import { findFinderCenter, refineFrameQuad } from "../src/lib/finder";
import { processFrameWithQuad } from "../src/lib/receiver";

function randomRgba(w: number, h: number, seed = 7): Uint8ClampedArray {
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

describe("solveHomographyLS", () => {
  it("matches getPerspectiveTransform on 4 correspondences", () => {
    const srcs = [
      { x: 0, y: 0 },
      { x: 1200, y: 0 },
      { x: 1200, y: 1200 },
      { x: 0, y: 1200 },
    ];
    const dsts = [
      { x: 300, y: 260 },
      { x: 2900, y: 340 },
      { x: 2860, y: 2120 },
      { x: 260, y: 2040 },
    ];
    const hLS = solveHomographyLS(srcs, dsts);
    const hX = getPerspectiveTransform(srcs, dsts);
    for (const p of [{ x: 600, y: 600 }, { x: 1150, y: 90 }, { x: 40, y: 1150 }]) {
      const a = applyH(hLS, p);
      const b = applyH(hX, p);
      expect(Math.abs(a.x - b.x)).toBeLessThan(1e-3);
      expect(Math.abs(a.y - b.y)).toBeLessThan(1e-3);
    }
  });

  it("composes matrices consistently", () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9] as number[];
    const b = [9, 8, 7, 6, 5, 4, 3, 2, 1] as number[];
    const ab = matMul3(a, b);
    const ba = matMul3(b, a);
    expect(ab).not.toEqual(ba); // non-commutative
    expect(ab.length).toBe(9);
  });
});

describe("finder refinement", () => {
  async function makeCamera() {
    const w = 64;
    const h = 48;
    const src = randomRgba(w, h);
    const key = "finder-key";
    const enc = await encodeImage({ rgba: src, width: w, height: h, key });
    const mat = buildMetaMatrix(makePayload(enc.width, enc.height, { pw: enc.pw, ph: enc.ph }, enc.checksum, enc.groupCrcs));
    const winW = 960;
    const winH = 720;
    const S = Math.min(winW, winH);
    const display = composeDisplay(enc.rgba, enc.pw, enc.ph, mat, winW, winH);
    // The FRAME is the inner square of the display; warp only that onto the
    // camera quad so the frame corners coincide with the quad corners.
    const sx = (winW - S) / 2;
    const sy = (winH - S) / 2;
    const squareDisp = [
      { x: sx, y: sy },
      { x: sx + S, y: sy },
      { x: sx + S, y: sy + S },
      { x: sx, y: sy + S },
    ];
    const camW = 1600;
    const camH = 1200;
    const gt = [
      { x: 200, y: 140 },
      { x: 1420, y: 190 },
      { x: 1390, y: 1060 },
      { x: 170, y: 1010 },
    ];
    const cam = renderInto(
      display,
      winW,
      winH,
      squareDisp,
      gt,
      camW,
      camH
    );
    const coarse = gt.map((p, i) => ({
      x: p.x + [6, -7, 5, -4][i],
      y: p.y + [-5, 6, -4, 7][i],
    }));
    return { cam, camW, camH, key, gt, coarse, src, w, h };
  }

  it("locates a finder center via its white ring", async () => {
    const { cam, camW, camH, gt } = await makeCamera();
    // Ground-truth finder centers: canonical positions mapped through gt.
    const square = [
      { x: 0, y: 0 },
      { x: 1200, y: 0 },
      { x: 1200, y: 1200 },
      { x: 0, y: 1200 },
    ];
    const H = getPerspectiveTransform(square, gt);
    const c = 0.11 * 1200;
    const canonical = [
      { x: c, y: c },
      { x: 1200 - c, y: c },
      { x: c, y: 1200 - c },
    ];
    for (const fc of canonical) {
      const pred = applyH(H, fc);
      const got = findFinderCenter(cam, camW, camH, pred, 80, (2 * 80) / 7 / 2.2);
      expect(got).not.toBeNull();
      if (got) {
        // A projective warp shifts the black module's centroid slightly off the
        // mapped center (perspective bias); the recovered center must land well
        // within the finder (a few px), far tighter than the coarse detection.
        expect(Math.hypot(got.x - pred.x, got.y - pred.y)).toBeLessThan(2.5);
      }
    }
  });

  it("recovers a perturbed coarse quad to sub-pixel accuracy", async () => {
    const { cam, camW, camH, gt, coarse } = await makeCamera();
    const refined = refineFrameQuad(cam, camW, camH, coarse);
    expect(refined).not.toBeNull();
    if (refined) {
      const coarseErr = coarse.reduce((s, p, i) => s + Math.hypot(p.x - gt[i].x, p.y - gt[i].y), 0);
      const refinedErr = refined.reduce((s, p, i) => s + Math.hypot(p.x - gt[i].x, p.y - gt[i].y), 0);
      expect(refinedErr).toBeLessThan(coarseErr * 0.5);
      expect(refinedErr).toBeLessThan(6);
    }
  });

  it("decodes from the coarse quad thanks to refinement (realistic error)", async () => {
    const { cam, camW, camH, key, coarse, src, w, h } = await makeCamera();
    // Without refinement the offset corners mis-sample scrambled cells.
    const raw = await processFrameWithQuad({ rgba: cam, width: camW, height: camH, key }, coarse);
    expect(raw.refined).toBe(true);
    expect(raw.status.stage).toBe("decoded");
    if (raw.status.stage === "decoded") {
      // Values recovered within quantized tolerance of the source.
      for (let i = 0; i < w * h; i++) {
        expect(Math.abs(raw.status.result.rgba[i * 4] - src[i * 4])).toBeLessThanOrEqual(8);
      }
    }
  });
});