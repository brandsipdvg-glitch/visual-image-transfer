// Sub-pixel frame registration using the three QR-style finder markers.
//
// The coarse white-frame detection locates the frame to within a few pixels,
// which after warping to the padded canvas is not accurate enough to sample
// scrambled cells exactly. Each finder is a radially-symmetric ring whose white
// band can be located far more precisely: within a small search window we take
// the largest connected white component (the ring) and compute its centroid.
// Three refined centers + the coarse frame corners give a least-squares
// homography that locks the data registration to sub-pixel accuracy.
import { CANONICAL, finderCanonicalCenters, GEOM } from "./compose";
import { applyH, getPerspectiveTransform, solveHomographyLS, type P2 } from "./warp";

const FINDER_HALF_CANONICAL = (GEOM.finderSize / 2) * CANONICAL;

// Locate one finder near an expected position. Returns a sub-pixel center in
// camera pixel coordinates, or null if the marker cannot be found.
//
// Each finder is a 7-module pattern: black outer ring, white ring, black center
// module. The black center is a closed blob fully surrounded by white, so it is
// immune to adjacent noise data fusing onto the white ring. We find the largest
// black component that does NOT touch the search window border (that is the
// center; the margin outside the ring touches the border instead) and return
// its centroid. `moduleSize` is the finder's module pitch in camera pixels.
export function findFinderCenter(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  pred: P2,
  winHalf: number,
  moduleSize: number
): P2 | null {
  const x0 = Math.max(0, Math.floor(pred.x - winHalf));
  const x1 = Math.min(w - 1, Math.ceil(pred.x + winHalf));
  const y0 = Math.max(0, Math.floor(pred.y - winHalf));
  const y1 = Math.min(h - 1, Math.ceil(pred.y + winHalf));
  const ww = x1 - x0 + 1;
  const wh = y1 - y0 + 1;
  if (ww < 12 || wh < 12) return null;

  const lum = new Float32Array(ww * wh);
  const black = new Uint8Array(ww * wh);
  let maxLum = 0;
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const i = ((y0 + y) * w + (x0 + x)) * 4;
      const L = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      lum[y * ww + x] = L;
      if (L > maxLum) maxLum = L;
    }
  }
  if (maxLum < 150) return null; // too dark to resolve the pattern
  const thresh = 0.42 * maxLum;
  for (let i = 0; i < lum.length; i++) black[i] = lum[i] < thresh ? 1 : 0;

  // Largest black component NOT touching the window border.
  let best: { cx: number; cy: number; area: number; minSide: number; maxSide: number } | null = null;
  const visited = new Uint8Array(black.length);
  const stack = new Int32Array(black.length);
  const isEdge = (x: number, y: number) => x === 0 || y === 0 || x === ww - 1 || y === wh - 1;
  for (let i = 0; i < black.length; i++) {
    if (!black[i] || visited[i]) continue;
    let sp = 0;
    stack[sp++] = i;
    visited[i] = 1;
    let area = 0;
    let sumx = 0;
    let sumy = 0;
    let touchesBorder = false;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    while (sp > 0) {
      const c = stack[--sp];
      const cx = c % ww;
      const cy = (c - cx) / ww;
      if (isEdge(cx, cy)) touchesBorder = true;
      area++;
      sumx += cx;
      sumy += cy;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      const nbs = [
        c - ww, c + ww,
        (cx > 0 ? c - 1 : -1),
        (cx < ww - 1 ? c + 1 : -1),
      ];
      for (let k = 0; k < 4; k++) {
        const nb = nbs[k];
        if (nb < 0 || nb >= black.length) continue;
        if (black[nb] && !visited[nb]) {
          visited[nb] = 1;
          stack[sp++] = nb;
        }
      }
    }
    if (touchesBorder) continue;
    if (area > (best?.area ?? 0)) {
      best = {
        cx: sumx / area,
        cy: sumy / area,
        area,
        minSide: Math.min(maxX - minX + 1, maxY - minY + 1),
        maxSide: Math.max(maxX - minX + 1, maxY - minY + 1),
      };
    }
  }
  if (!best) return null;

  // The center module is a 3x3 block of `moduleSize` pixels (~9*m^2), roughly
  // square, sitting near the window middle. Guard generously against noise.
  const m = moduleSize;
  const expectedArea = 9 * m * m;
  if (best.area < 0.25 * expectedArea || best.area > 6 * expectedArea) return null;
  if (best.minSide < 1.8 * m || best.maxSide > 8 * m) return null;
  const offX = best.cx - (ww - 1) / 2;
  const offY = best.cy - (wh - 1) / 2;
  if (Math.hypot(offX, offY) > 0.6 * winHalf) return null;
  const cpx = Math.max(1, Math.min(w - 2, x0 + best.cx));
  const cpy = Math.max(1, Math.min(h - 2, y0 + best.cy));
  return { x: cpx, y: cpy };
}

// Refine a coarse frame quad using the finder markers. Returns a refined quad
// (canonical square corners in camera coordinates) or null if unusable.
export function refineFrameQuad(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  coarseQuad: P2[]
): P2[] | null {
  const square: P2[] = [
    { x: 0, y: 0 },
    { x: CANONICAL, y: 0 },
    { x: CANONICAL, y: CANONICAL },
    { x: 0, y: CANONICAL },
  ];
  const Hc = getPerspectiveTransform(square, coarseQuad);
  const centers = finderCanonicalCenters(CANONICAL);
  const refined: P2[] = [];
  for (const fc of centers) {
    const pred = applyH(Hc, fc);
    // Camera-space half-extent of the finder, estimated along the x axis.
    const edge = applyH(Hc, { x: fc.x + FINDER_HALF_CANONICAL, y: fc.y });
    const halfCam = Math.hypot(edge.x - pred.x, edge.y - pred.y);
    if (halfCam < 4) continue;
    const moduleSize = (2 * halfCam) / 7;
    const got = findFinderCenter(rgba, w, h, pred, 2.2 * halfCam, moduleSize);
    if (got) refined.push(got);
  }
  if (refined.length < 2) return null;

  // Weighted least-squares over coarse frame corners + refined finder centers:
  // the finder localizations are far more reliable than the coarse corners
  // (which may be a few pixels off). Trust them heavily.
  const srcs = [...square, ...centers];
  const dsts = [...coarseQuad, ...refined];
  const weights = [...new Array<number>(coarseQuad.length).fill(0.02), ...new Array<number>(refined.length).fill(1)];
  try {
    const H = solveHomographyLS(srcs, dsts, weights);
    return square.map((p) => applyH(H, p));
  } catch {
    return null;
  }
}