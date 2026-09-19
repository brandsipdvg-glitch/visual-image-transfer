// Perspective (homography) helpers: 3x3 matrix in row-major order.
export type Mat3 = number[]; // length 9, row-major
export interface P2 {
  x: number;
  y: number;
}

// Solve homography mapping src quad -> dst quad (4 point correspondences)
// via the standard DLT, normalized to h33 = 1.
export function getPerspectiveTransform(
  src: P2[],
  dst: P2[]
): Mat3 {
  if (src.length !== 4 || dst.length !== 4) {
    throw new Error("homography requires 4 point correspondences");
  }
  // Augmented system A (8 x 9) with unknowns h11..h32 and constant h33=1.
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const x = src[i].x;
    const y = src[i].y;
    const u = dst[i].x;
    const v = dst[i].y;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gauss-Jordan with partial pivoting.
  const n = 8;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    }
    if (Math.abs(A[piv][col]) < 1e-12) {
      throw new Error("degenerate homography");
    }
    if (piv !== col) {
      const t = A[col];
      A[col] = A[piv];
      A[piv] = t;
    }
    const pv = A[col][col];
    for (let c = 0; c <= n; c++) A[col][c] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (Math.abs(f) < 1e-15) continue;
      for (let c = 0; c <= n; c++) A[r][c] -= f * A[col][c];
    }
  }
  const h = new Array<number>(9).fill(0);
  for (let r = 0; r < 8; r++) h[r] = A[r][8];
  h[8] = 1;
  return normalizeMat(h);
}

export function applyH(m: Mat3, p: P2): P2 {
  const { x, y } = p;
  const w = m[6] * x + m[7] * y + m[8];
  if (Math.abs(w) < 1e-12) return { x: -1, y: -1 };
  return {
    x: (m[0] * x + m[1] * y + m[2]) / w,
    y: (m[3] * x + m[4] * y + m[5]) / w,
  };
}

// Map a canonical (square) rectangle into source space given the homography
// from source -> canonical.
export function transformQuad(m: Mat3, quad: P2[]): P2[] {
  return quad.map((p) => applyH(m, p));
}

function normalizeMat(m: Mat3): Mat3 {
  const n = Math.sqrt(m.reduce((s, v) => s + v * v, 0));
  if (n < 1e-9) return m;
  return m.map((v) => v / n);
}

export interface RenderOptions {
  supersample?: number; // samples per axis (1 = bilinear at centers, 2 = 2x2)
  nearest?: boolean; // point-sample (nearest) instead of bilinear interpolation
}

// Render a source quadrilateral into a destW x destH rgba buffer. Sampling is
// inverse-warped: each dest pixel CENTER maps back through the homography to a
// source point, bilinearly interpolated.
export function renderRect(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  quad: P2[],
  dstW: number,
  dstH: number,
  opts: RenderOptions = {}
): Uint8ClampedArray {
  const ss = Math.max(1, Math.round(opts.supersample ?? 1));
  // Homography mapping source quad -> dest pixel units, then invert for
  // inverse warping (dest pixel center -> source coordinate).
  const Hs = getPerspectiveTransform(quad, [
    { x: 0, y: 0 },
    { x: dstW, y: 0 },
    { x: dstW, y: dstH },
    { x: 0, y: dstH },
  ]);
  const Hi = invertMat(Hs);
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  if (!Hi) return out;
  const sample = opts.nearest ? sampleNearest : sampleBilinear;
  if (ss === 1) {
    for (let y = 0; y < dstH; y++) {
      for (let x = 0; x < dstW; x++) {
        const p = applyH(Hi, { x: x + 0.5, y: y + 0.5 });
        sample(src, srcW, srcH, p.x, p.y, out, (y * dstW + x) * 4);
      }
    }
    return out;
  }
  // supersample
  const acc = new Float32Array(3);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      acc[0] = acc[1] = acc[2] = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const p = applyH(Hi, {
            x: x + (sx + 0.5) / ss,
            y: y + (sy + 0.5) / ss,
          });
          const tmp = new Uint8ClampedArray(4);
          sample(src, srcW, srcH, p.x, p.y, tmp, 0);
          acc[0] += tmp[0];
          acc[1] += tmp[1];
          acc[2] += tmp[2];
        }
      }
      const o = (y * dstW + x) * 4;
      out[o] = acc[0] / (ss * ss);
      out[o + 1] = acc[1] / (ss * ss);
      out[o + 2] = acc[2] / (ss * ss);
      out[o + 3] = 255;
    }
  }
  return out;
}

function sampleNearest(
  a: Uint8ClampedArray,
  w: number,
  h: number,
  fx: number,
  fy: number,
  out: Uint8ClampedArray,
  o: number
): void {
  const x = Math.max(0, Math.min(w - 1, Math.floor(fx)));
  const y = Math.max(0, Math.min(h - 1, Math.floor(fy)));
  const i = (y * w + x) * 4;
  out[o] = a[i];
  out[o + 1] = a[i + 1];
  out[o + 2] = a[i + 2];
  out[o + 3] = 255;
}

// 3x3 matrix inverse (row-major). Returns null when singular.
export function invertMat(m: Mat3): Mat3 | null {
  const a = m[0], b = m[1], c = m[2];
  const d = m[3], e = m[4], f = m[5];
  const g = m[6], h = m[7], i = m[8];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return [
    (e * i - f * h) * inv, (c * h - b * i) * inv, (b * f - c * e) * inv,
    (f * g - d * i) * inv, (a * i - c * g) * inv, (c * d - a * f) * inv,
    (d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv,
  ];
}

// Forward-warp `src` (region srcRect) into a dstW x dstH buffer so that the
// content appears at the (perspective) quad location. Everything else is black.
export function renderInto(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  srcRect: P2[],
  quad: P2[],
  dstW: number,
  dstH: number,
  opts: RenderOptions = {}
): Uint8ClampedArray {
  const H = getPerspectiveTransform(srcRect, quad); // display -> camera
  const Hi = invertMat(H);
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  if (!Hi) return out;
  const sample = opts.nearest ? sampleNearest : sampleBilinear;
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const p = applyH(Hi, { x, y });
      sample(src, srcW, srcH, p.x, p.y, out, (y * dstW + x) * 4);
    }
  }
  return out;
}

function sampleBilinear(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  fx: number,
  fy: number,
  out: Uint8ClampedArray,
  o: number
): void {
  if (fx < 0 || fy < 0 || fx > srcW - 1 || fy > srcH - 1) {
    out[o] = out[o + 1] = out[o + 2] = 0;
    out[o + 3] = 255;
    return;
  }
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(srcW - 1, x0 + 1);
  const y1 = Math.min(srcH - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const i00 = (y0 * srcW + x0) * 4;
  const i10 = (y0 * srcW + x1) * 4;
  const i01 = (y1 * srcW + x0) * 4;
  const i11 = (y1 * srcW + x1) * 4;
  for (let c = 0; c < 3; c++) {
    const top = src[i00 + c] * (1 - tx) + src[i10 + c] * tx;
    const bot = src[i01 + c] * (1 - tx) + src[i11 + c] * tx;
    out[o + c] = top * (1 - ty) + bot * ty;
  }
  out[o + 3] = 255;
}

// Average RGBA -> luminance within each of `grids`x`grids` cells of a projected
// quadrilateral. For each cell we subsample `sub`x`sub` bilinear points at the
// cell's normalized center region (projected through the quad homography), so
// reads are robust to perspective distortion and block-edge bleed.
export function cellLuminanceQuad(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  quad: P2[],
  grids: number,
  sub = 4
): Float32Array {
  const H = getPerspectiveTransform(
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    quad
  );
  const lum = new Float32Array(grids * grids);
  if (!H) return lum;
  const tmp = new Uint8ClampedArray(4);
  for (let gy = 0; gy < grids; gy++) {
    for (let gx = 0; gx < grids; gx++) {
      let sum = 0;
      let n = 0;
      for (let sy = 0; sy < sub; sy++) {
        for (let sx = 0; sx < sub; sx++) {
          const u = (gx + (sx + 0.5) / sub) / grids;
          const v = (gy + (sy + 0.5) / sub) / grids;
          const p = applyH(H, { x: u, y: v });
          sampleBilinear(rgba, w, h, p.x, p.y, tmp, 0);
          sum += 0.299 * tmp[0] + 0.587 * tmp[1] + 0.114 * tmp[2];
          n++;
        }
      }
      lum[gy * grids + gx] = sum / n;
    }
  }
  return lum;
}

// Average RGB -> luminance of an rgba buffer region (rows*cols sub-rectangles).
export function cellLuminance(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  grids: number
): Float32Array {
  const cw = w / grids;
  const ch = h / grids;
  const lum = new Float32Array(grids * grids);
  for (let gy = 0; gy < grids; gy++) {
    for (let gx = 0; gx < grids; gx++) {
      let sum = 0;
      let n = 0;
      const x0 = Math.floor(gx * cw);
      const x1 = Math.min(w, Math.ceil((gx + 1) * cw));
      const y0 = Math.floor(gy * ch);
      const y1 = Math.min(h, Math.ceil((gy + 1) * ch));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
          n++;
        }
      }
      lum[gy * grids + gx] = n ? sum / n : 0;
    }
  }
  return lum;
}