// Detect the sender's white FRAME quadrilateral in a camera frame.
// Returns 4 corners (clockwise from top-left in image coords) or null.
import type { P2 } from "./warp";

const DETECT_MAX = 176; // downscale for detection

export function toGray(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    g[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  }
  return g;
}

function downscaleGray(
  gray: Float32Array,
  w: number,
  h: number,
  maxDim: number
): { g: Float32Array; w: number; h: number } {
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(h - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(w - 1, Math.floor((x + 0.5) / scale));
      out[y * dw + x] = gray[sy * w + sx];
    }
  }
  return { g: out, w: dw, h: dh };
}

// Largest connected component in a binary mask; returns mask + bbox.
function largestComponent(
  mask: Uint8Array,
  w: number,
  h: number
): { mask: Uint8Array; area: number; minX: number; minY: number; maxX: number; maxY: number } {
  const visited = new Uint8Array(w * h);
  const stack: number[] = [];
  let best = {
    mask: new Uint8Array(0),
    area: 0,
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
  };
  for (let start = 0; start < w * h; start++) {
    if (visited[start] || !mask[start]) continue;
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    let area = 0;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    while (stack.length > 0) {
      const p = stack.pop()!;
      area++;
      const px = p % w;
      const py = (p / w) | 0;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      if (px > 0 && !visited[p - 1] && mask[p - 1]) { visited[p - 1] = 1; stack.push(p - 1); }
      if (px < w - 1 && !visited[p + 1] && mask[p + 1]) { visited[p + 1] = 1; stack.push(p + 1); }
      if (py > 0 && !visited[p - w] && mask[p - w]) { visited[p - w] = 1; stack.push(p - w); }
      if (py < h - 1 && !visited[p + w] && mask[p + w]) { visited[p + w] = 1; stack.push(p + w); }
    }
    if (area > best.area && area >= 8) {
      best = { mask: visited.slice(0), area, minX, minY, maxX, maxY };
    }
  }
  return best;
}

// Binary mask of pixels above a threshold.
function binaryMask(gray: Float32Array, thr: number): Uint8Array {
  const m = new Uint8Array(gray.length);
  for (let i = 0; i < m.length; i++) m[i] = gray[i] >= thr ? 1 : 0;
  return m;
}

// 3x3 dilation: bridges 1-2 px gaps (screen-door/moire breakout on real cameras).
function dilateMask(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let set = mask[y * w + x];
      if (!set) {
        const y0 = Math.max(0, y - 1);
        const y1 = Math.min(h - 1, y + 1);
        const x0 = Math.max(0, x - 1);
        const x1 = Math.min(w - 1, x + 1);
        for (let yy = y0; yy <= y1 && !set; yy++) {
          for (let xx = x0; xx <= x1 && !set; xx++) {
            if (mask[yy * w + xx]) set = 1;
          }
        }
      }
      out[y * w + x] = set;
    }
  }
  return out;
}

// Robust low/high from percentiles so exposure/brightness is normalized out.
function robustRange(gray: Float32Array): { lo: number; hi: number } {
  const a = gray.slice(); // new Float32Array(gray) copy
  a.sort();
  const n = a.length;
  return {
    lo: a[Math.min(n - 1, (n * 0.005) | 0)],
    hi: a[Math.min(n - 1, (n * 0.985) | 0)],
  };
}

// In-place contrast stretch of gray to full range.
function normalize(gray: Float32Array, lo: number, hi: number): void {
  const span = hi - lo;
  if (span < 4) return;
  const inv = 255 / span;
  for (let i = 0; i < gray.length; i++) {
    let v = (gray[i] - lo) * inv;
    if (v < 0) v = 0;
    else if (v > 255) v = 255;
    gray[i] = v;
  }
}

// Convex hull (Andrew's monotone chain). Returns hull points (cw).
function convexHull(points: P2[]): P2[] {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: P2, a: P2, b: P2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: P2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: P2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// Approximate hull to 4 corners by sharpest curvature.
function hullToQuad(hull: P2[]): P2[] | null {
  if (hull.length < 4) return null;
  const n = hull.length;
  const corners: { score: number; idx: number }[] = [];
  for (let i = 0; i < n; i++) {
    const prev = hull[(i - 1 + n) % n];
    const cur = hull[i];
    const next = hull[(i + 1) % n];
    const a = Math.atan2(prev.y - cur.y, prev.x - cur.x);
    const b = Math.atan2(next.y - cur.y, next.x - cur.x);
    let d = Math.abs(a - b);
    if (d > Math.PI) d = 2 * Math.PI - d;
    // corner score: how much the path turns (pi - angle)
    corners.push({ score: Math.PI - d, idx: i });
  }
  corners.sort((x, y) => y.score - x.score);
  const picked = corners.slice(0, 4).map((c) => hull[c.idx]);
  // Order clockwise starting at the point closest to image top-left.
  picked.sort((a, b) => a.x + a.y - (b.x + b.y));
  const [tl, tr2, br2, bl2] = orderQuad(picked);
  void tr2; void br2; void bl2;
  return [tl, tr2, br2, bl2];
}

// Given 4 points, order them clockwise from top-left.
export function orderQuad(pts: P2[]): P2[] {
  const center = pts.reduce((s, p) => ({ x: s.x + p.x / 4, y: s.y + p.y / 4 }), { x: 0, y: 0 });
  const withAng = pts.map((p) => ({
    p,
    a: Math.atan2(p.y - center.y, p.x - center.x),
  }));
  withAng.sort((a, b) => a.a - b.a);
  // angles: top-right ~ -pi/4 ... reorder to TL, TR, BR, BL
  const s = withAng.map((w) => w.p);
  // s[?]. Find index of TL (small x, small y) = min x+y.
  let tl = 0;
  for (let i = 1; i < 4; i++) if (s[i].x + s[i].y < s[tl].x + s[tl].y) tl = i;
  return [s[tl], s[(tl + 1) % 4], s[(tl + 2) % 4], s[(tl + 3) % 4]];
}

function quadQuality(hull: P2[], quad: P2[]): number {
  let err = 0;
  for (const p of hull) {
    let best = Infinity;
    for (let i = 0; i < 4; i++) {
      const a = quad[i];
      const b = quad[(i + 1) % 4];
      best = Math.min(best, pointSegDist(p, a, b));
    }
    err += best;
  }
  return err / Math.max(1, hull.length);
}

function pointSegDist(p: P2, a: P2, b: P2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = a.x + t * dx;
  const qy = a.y + t * dy;
  return Math.hypot(p.x - qx, p.y - qy);
}

// Refine the coarse quad to subpixel-ish accuracy by finding the OUTER edge of
// the bright frame on each side and intersecting the fitted lines. Robust to
// the downscale/anti-aliasing blur that shrinks the coarse corners.
export function refineQuad(
  gray: Float32Array,
  w: number,
  h: number,
  quad: P2[],
  thr: number,
  searchBand = 24
): P2[] {
  const sides: { a: P2; b: P2; outward: P2 }[] = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    // outward normal (points away from the square interior) for clockwise
    // TL -> TR -> BR -> BL order in y-down image coordinates.
    const nx = dy / L;
    const ny = -dx / L;
    sides.push({ a, b, outward: { x: nx, y: ny } });
  }

  const edgePoints: P2[][] = sides.map(() => []);
  const R = searchBand;
  for (let s = 0; s < 4; s++) {
    const { a, b, outward } = sides[s];
    const n = Math.max(8, Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / 6));
    for (let t = 0; t <= n; t++) {
      const f = t / n;
      const px = a.x + (b.x - a.x) * f;
      const py = a.y + (b.y - a.y) * f;
      let found: number | null = null;
      let coord = -1;
      // scan from OUTSIDE inward (k = +R outside, decreasing k goes into the
      // screen): the first bright pixel encountered is the outer frame edge.
      for (let k = R; k >= -R; k--) {
        const sx = px + outward.x * k;
        const sy = py + outward.y * k;
        const xi = Math.round(sx);
        const yi = Math.round(sy);
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
        const v = gray[yi * w + xi] >= thr ? 1 : 0;
        if (found === null && v === 1) {
          // transitioned into the bright frame
          const prev = k - 1;
          const pv = gray[Math.max(0, Math.min(h - 1, Math.round(py + outward.y * prev))) * w + Math.max(0, Math.min(w - 1, Math.round(px + outward.x * prev)))];
          const vv = gray[yi * w + xi];
          found = k;
          coord = vv - pv !== 0 ? vv / (vv + Math.max(thr - pv, 1)) : 0;
          break;
        }
      }
      if (found !== null) {
        const k = found;
        edgePoints[s].push({
          x: px + outward.x * (k + coord * 0.5),
          y: py + outward.y * (k + coord * 0.5),
        });
      }
    }
  }

  // Fit each side's edge points to a line (ax + by + c = 0) via least squares
  // on the normalized direction, then intersect adjacent lines.
  const lines = edgePoints.map((pts) => {
    if (pts.length < 3) return null;
    let mx = 0;
    let my = 0;
    for (const p of pts) {
      mx += p.x;
      my += p.y;
    }
    mx /= pts.length;
    my /= pts.length;
    // direction via PCA
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const p of pts) {
      sxx += (p.x - mx) * (p.x - mx);
      sxy += (p.x - mx) * (p.y - my);
      syy += (p.y - my) * (p.y - my);
    }
    // eigenvector of [[sxx,sxy],[sxy,syy]] (largest ev) = direction
    const ev = (sxx + syy + Math.sqrt((sxx - syy) * (sxx - syy) + 4 * sxy * sxy)) / 2;
    const ux = sxy;
    const uy = ev - sxx;
    const ul = Math.hypot(ux, uy) || 1;
    const dx = ux / ul;
    const dy = uy / ul;
    // line: normal n=(dy,-dx)? We want ax+by+c=0 passing through centroid
    const an = dy;
    const bn = -dx;
    const cn = -(an * mx + bn * my);
    return { an, bn, cn };
  });

  const refined: P2[] = new Array(4);
  for (let i = 0; i < 4; i++) {
    const l1 = lines[i];
    const l2 = lines[(i + 1) % 4];
    if (!l1 || !l2) return quad;
    const det = l1.an * l2.bn - l2.an * l1.bn;
    if (Math.abs(det) < 1e-9) return quad;
    refined[i] = {
      x: (l2.bn * -l1.cn - l1.bn * -l2.cn) / det,
      y: (l1.an * -l2.cn - l2.an * -l1.cn) / det,
    };
  }

  // sanity: points should be finite and near the coarse ones
  for (let i = 0; i < 4; i++) {
    if (!Number.isFinite(refined[i].x) || !Number.isFinite(refined[i].y)) return quad;
  }
  return orderQuad(refined);
}

export interface DetectedQuad {
  quad: P2[]; // full-resolution image coords, ordered TL,TR,BR,BL
  usedThreshold: number;
}

// Main entry point.
export function detectFrame(
  rgba: Uint8ClampedArray,
  w: number,
  h: number
): DetectedQuad | null {
  const gray = toGray(rgba, w, h);
  const ds = downscaleGray(gray, w, h, DETECT_MAX);
  // Normalize both scales with the same range so camera exposure/brightness
  // doesn't decide whether the white frame crosses the threshold.
  const { lo, hi } = robustRange(ds.g);
  normalize(ds.g, lo, hi);
  const full = gray; // full-resolution gray, parsed by reference (same values)
  normalize(full, lo, hi);
  for (const thr of [235, 205, 175, 145]) {
    let mask = binaryMask(ds.g, thr);
    mask = dilateMask(mask, ds.w, ds.h);
    const comp = largestComponent(mask, ds.w, ds.h);
    if (comp.area < 16) continue;
    const bw = comp.maxX - comp.minX + 1;
    const bh = comp.maxY - comp.minY + 1;
    if (bw < 0.25 * ds.w || bh < 0.25 * ds.h) continue; // too small / partial
    // Build hull points from the mask (sample pixels to keep it cheap).
    const pts: P2[] = [];
    const step = Math.max(1, Math.floor(Math.sqrt(comp.area / 2000)));
    for (let y = comp.minY; y <= comp.maxY; y += step) {
      for (let x = comp.minX; x <= comp.maxX; x += step) {
        if (comp.mask[y * ds.w + x]) pts.push({ x, y });
      }
    }
    if (pts.length < 4) continue;
    const hull = convexHull(pts);
    if (hull.length < 4) continue;
    const quad = hullToQuad(hull);
    if (!quad) continue;
    const err = quadQuality(hull, quad);
    const diag = Math.hypot(ds.w, ds.h);
    if (err > 0.045 * diag) continue; // poor fit, not screen-like
    // Map corner coordinates back to full-res.
    const scaleX = w / ds.w;
    const scaleY = h / ds.h;
    const fullResQuad = quad.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY }));
    const refined = refineQuad(full, w, h, fullResQuad, thr);
    return { quad: refined, usedThreshold: thr };
  }
  return null;
}