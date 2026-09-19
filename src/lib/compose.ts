// Shared display geometry used by BOTH sender (fullscreen render) and
// receiver (decode after warp to a canonical square of side CANONICAL).
//
// The fullscreen display is composed as:
//   - black background
//   - a white FRAME square (detection anchor) of side S (S = min(winW, winH))
//   - the encoded noise canvas stretched into the central "data rect"
//   - a metadata block in the top-left margin (never scrambled)
//
// All positions are FRACTIONS of S, so a sender window of any size and a
// receiver canonical square always agree.
import { META_GRID } from "./meta";
import type { P2 } from "./warp";

export const CANONICAL = 1200; // receiver warps the frame to this square

export const GEOM = {
  // Frame: white border thickness as fraction of S.
  frameThickness: 0.02,
  // Black margin between the frame inner edge and the data rect. The metadata
  // block sits on this band (see metaSize/metaOffset), so the data region stays
  // pristine -- the receiver never has to read come under an overlay.
  dataInset: 0.28,
  // Metadata block: top-left corner offset from frame OUTER edge, placed in
  // the black margin between the frame ring and the data rect so it never
  // paints over the detection frame. Sized generously (24% of the frame) so
  // each cell is several source pixels after perspective + camera downscale.
  metaSize: 0.24,
  // Offset just inside the frame inner edge (frameThickness) so the block
  // sits fully on the black margin band.
  metaOffset: 0.03,
} as const;

export interface GeometryRects {
  frameOuter: P2[]; // square corners, clockwise from top-left
  frameInner: P2[];
  dataRect: P2[];
  metaRect: P2[];
  metaGridPx: number; // cell side in canonical px (= S_frac * CANONICAL / META_GRID)
}

// Build the rectangles in a canonical square of side S (unit square of the
// fullscreen area; sender uses S = min(winW, winH), receiver uses CANONICAL).
export function buildRects(S: number): GeometryRects {
  const f = GEOM.frameThickness * S;
  const inset = GEOM.dataInset * S;
  const mSize = GEOM.metaSize * S;
  const mOff = GEOM.metaOffset * S;

  const frameOuter: P2[] = [
    { x: 0, y: 0 },
    { x: S, y: 0 },
    { x: S, y: S },
    { x: 0, y: S },
  ];
  const frameInner: P2[] = [
    { x: f, y: f },
    { x: S - f, y: f },
    { x: S - f, y: S - f },
    { x: f, y: S - f },
  ];
  const dataRect: P2[] = [
    { x: f + inset, y: f + inset },
    { x: S - f - inset, y: f + inset },
    { x: S - f - inset, y: S - f - inset },
    { x: f + inset, y: S - f - inset },
  ];
  const metaRect: P2[] = [
    { x: mOff, y: mOff },
    { x: mOff + mSize, y: mOff },
    { x: mOff + mSize, y: mOff + mSize },
    { x: mOff, y: mOff + mSize },
  ];
  return {
    frameOuter,
    frameInner,
    dataRect,
    metaRect,
    metaGridPx: mSize / META_GRID,
  };
}

// Draw the metadata grid into an rgba buffer given the block rect.
export function drawMetaBlock(
  dst: Uint8ClampedArray,
  dstW: number,
  dstH: number,
  matrix: Uint8Array, // META_GRID*META_GRID 0/1
  rect: P2[]
): void {
  // Draw only the block region itself; the rect already carries a white outer
  // ring (meta ring 1), so no extra margin is needed and nothing outside the
  // block is ever touched.
  const x0 = rect.reduce((m, p) => Math.min(m, p.x), Infinity);
  const x1 = rect.reduce((m, p) => Math.max(m, p.x), -Infinity);
  const y0 = rect.reduce((m, p) => Math.min(m, p.y), Infinity);
  const y1 = rect.reduce((m, p) => Math.max(m, p.y), -Infinity);
  const bw = x1 - x0;
  const bh = y1 - y0;
  const sx0 = Math.max(0, Math.floor(x0));
  const sy0 = Math.max(0, Math.floor(y0));
  const ex0 = Math.min(dstW, Math.ceil(x1));
  const ey0 = Math.min(dstH, Math.ceil(y1));
  for (let sy = sy0; sy < ey0; sy++) {
    for (let sx = sx0; sx < ex0; sx++) {
      const i = (sy * dstW + sx) * 4;
      const gx = clampInt(Math.floor(((sx + 0.5 - x0) / bw) * META_GRID), 0, META_GRID - 1);
      const gy = clampInt(Math.floor(((sy + 0.5 - y0) / bh) * META_GRID), 0, META_GRID - 1);
      const v = matrix[gy * META_GRID + gx];
      dst[i] = dst[i + 1] = dst[i + 2] = v ? 255 : 0;
      dst[i + 3] = 255;
    }
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Compose the fullscreen display image (window of size winW x winH).
export function composeDisplay(
  encodedRgba: Uint8ClampedArray, // pw*ph*4
  pw: number,
  ph: number,
  metaMatrix: Uint8Array,
  winW: number,
  winH: number
): Uint8ClampedArray {
  const S = Math.min(winW, winH);
  const rects = buildRects(S);
  const out = new Uint8ClampedArray(winW * winH * 4).fill(0);

  const cx = (winW - S) / 2;
  const cy = (winH - S) / 2;

  // Frame: white ring.
  const f = GEOM.frameThickness * S;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const a = x < f || x >= S - f || y < f || y >= S - f;
      if (a) {
        const i = ((cy + y) * winW + (cx + x)) * 4;
        out[i] = out[i + 1] = out[i + 2] = 255;
        out[i + 3] = 255;
      }
    }
  }

  // Data rect: stretch encoded noise.
  const dr = rects.dataRect;
  const dx0 = Math.round(cx + dr[0].x);
  const dx1 = Math.round(cx + dr[2].x);
  const dy0 = Math.round(cy + dr[0].y);
  const dy1 = Math.round(cy + dr[2].y);
  for (let y = dy0; y < dy1; y++) {
    const fy = ((y - dy0) / (dy1 - dy0)) * ph;
    const sy = Math.min(ph - 1, Math.max(0, Math.floor(fy)));
    for (let x = dx0; x < dx1; x++) {
      const fx = ((x - dx0) / (dx1 - dx0)) * pw;
      const sx = Math.min(pw - 1, Math.max(0, Math.floor(fx)));
      const si = (sy * pw + sx) * 4;
      const o = (y * winW + x) * 4;
      out[o] = encodedRgba[si];
      out[o + 1] = encodedRgba[si + 1];
      out[o + 2] = encodedRgba[si + 2];
      out[o + 3] = 255;
    }
  }

  // Metadata block (offset by cx/cy since rects are in square coords).
  const mRect = rects.metaRect.map((p) => ({ x: cx + p.x, y: cy + p.y }));
  drawMetaBlock(out, winW, winH, metaMatrix, mRect);

  return out;
}