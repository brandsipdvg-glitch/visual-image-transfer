import { VERSION, ALGORITHM_VERSION, BLOCK_SIZE } from "./encode";

// ---------------------------------------------------------------------------
// Metadata block design
//
// The metadata is drawn as a small bar-code-like square in the (black) margin
// of the fullscreen display. It is intentionally NOT scrambled: the receiver
// must be able to read width/height/checksum before running any inverse
// transform.
//
// Grid layout: META_GRID x META_GRID cells.
//   - outer 1-cell WHITE ring  (locator + white luminance reference)
//   - next 2-cell BLACK ring   (locator + dark luminance reference)
//   - inner (META_GRID-6) x (META_GRID-6) data cells
// Each metadata bit is replicated REDUNDANCY times for majority voting.
// ---------------------------------------------------------------------------
export const META_GRID = 34;
export const META_RING_WHITE = 1;
export const META_RING_BLACK = 2;
export const META_REDUNDANCY = 3;
export const META_INNER = META_GRID - 2 * (META_RING_WHITE + META_RING_BLACK);
export const META_MAGIC = 0xa5;

export interface MetadataPayload {
  version: number; // VERSION
  algoVersion: number; // ALGORITHM_VERSION
  width: number; // original content width
  height: number; // original content height
  pw: number; // padded canvas width
  ph: number; // padded canvas height
  blockSize: number;
  checksum: number; // CRC32 of the QUANTIZED original content
  groupCrcs: number[]; // 4x CRC16 over quantized content slices
}

export function payloadToBits(p: MetadataPayload): number[] {
  const bits: number[] = [];
  const push = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1);
  };
  const u16 = (v: number) => {
    push((v >> 8) & 0xff, 8);
    push(v & 0xff, 8);
  };
  push(META_MAGIC, 8);
  push(p.version, 8);
  push(p.algoVersion, 8);
  u16(p.pw);
  u16(p.ph);
  u16(p.width);
  u16(p.height);
  push(p.blockSize, 8);
  push(p.checksum >>> 0, 32);
  for (let g = 0; g < 4; g++) u16((p.groupCrcs[g] ?? 0) & 0xffff);
  return bits;
}

export function bitsToPayload(bits: number[]): MetadataPayload | null {
  let idx = 0;
  const next = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (idx >= bits.length) return -1;
      v = v * 2 + bits[idx++];
    }
    return v;
  };
  const magic = next(8);
  const version = next(8);
  const algoVersion = next(8);
  const pw = next(16);
  const ph = next(16);
  const width = next(16);
  const height = next(16);
  const blockSize = next(8);
  const checksum = next(32);
  const groupCrcs = [next(16), next(16), next(16), next(16)];

  if (
    magic !== META_MAGIC ||
    version < 0 ||
    algoVersion < 0 ||
    pw < 0 ||
    ph < 0 ||
    width < 0 ||
    height < 0 ||
    blockSize < 0 ||
    checksum < 0 ||
    groupCrcs.some((v) => v < 0)
  ) {
    return null;
  }
  return {
    version,
    algoVersion,
    width,
    height,
    pw,
    ph,
    blockSize,
    checksum,
    groupCrcs,
  };
}

function isValid(p: MetadataPayload): boolean {
  return (
    p.version === VERSION &&
    p.algoVersion === ALGORITHM_VERSION &&
    p.blockSize === BLOCK_SIZE &&
    p.pw >= 1 &&
    p.ph >= 1 &&
    p.pw % BLOCK_SIZE === 0 &&
    p.ph % BLOCK_SIZE === 0 &&
    p.width > 0 &&
    p.height > 0 &&
    p.width <= p.pw &&
    p.height <= p.ph
  );
}

// Build the bit matrix (grid of 0/1 cell values) from a payload.
export function buildMetaMatrix(payload: MetadataPayload): Uint8Array {
  // returns META_GRID*META_GRID values: 1 = white cell, 0 = black cell.
  const bits = payloadToBits(payload);
  const mat = new Uint8Array(META_GRID * META_GRID).fill(0);

  const dataStart = META_RING_WHITE + META_RING_BLACK;
  const dataEnd = META_GRID - (META_RING_WHITE + META_RING_BLACK);

  for (let y = 0; y < META_GRID; y++) {
    for (let x = 0; x < META_GRID; x++) {
      const i = y * META_GRID + x;
      if (x < META_RING_WHITE || y < META_RING_WHITE || x >= dataEnd || y >= dataEnd) {
        mat[i] = 1; // white outer ring
      } else if (
        x < dataStart ||
        y < dataStart ||
        x >= META_GRID - dataStart ||
        y >= META_GRID - dataStart
      ) {
        mat[i] = 0; // black inner ring
      }
    }
  }

  // Fill inner data cells (row-major) with redundant bit copies.
  const inner = META_INNER * META_INNER;
  const needed = bits.length * META_REDUNDANCY;
  if (needed > inner) {
    throw new Error("metadata grid too small for payload");
  }
  let bi = 0;
  for (let rep = 0; rep < META_REDUNDANCY; rep++) {
    for (let b = 0; b < bits.length; b++) {
      const dy = dataStart + Math.floor(bi / META_INNER);
      const dx = dataStart + (bi % META_INNER);
      mat[dy * META_GRID + dx] = bits[b];
      bi++;
    }
  }
  return mat;
}

// Read a sampled grid of per-cell averages -> payload (with voting).
export function readMetaMatrix(cellLum: Float32Array /* META_GRID*META_GRID lum [0..255] */): MetadataPayload | null {
  const N = META_GRID * META_GRID;

  // Robust black/white references from percentiles of the cell distribution
  // (immune to ring-bleed against the dark background).
  const sorted = Array.from(cellLum).sort((a, b) => a - b);
  const darkRef = sorted[Math.floor(N * 0.05)];
  const whiteRef = sorted[Math.floor(N * 0.95)];
  if (whiteRef - darkRef < 40) return null;
  const threshold = (darkRef + whiteRef) / 2;

  // Binarize all cells.
  const bin = new Uint8Array(N);
  for (let i = 0; i < N; i++) bin[i] = cellLum[i] >= threshold ? 1 : 0;

  const dataStart = META_RING_WHITE + META_RING_BLACK;
  const bits: number[] = [];

  // Recompute expected bit length from a provisional parse is circular, so we
  // read the full inner band (row-major) then majority-vote per META_REDUNDANCY
  // stride over the exact payload length.
  const probe = readPayloadLength(bin, dataStart);
  if (!probe) return null;
  const bitLen = probe;
  if (bitLen > META_INNER * META_INNER / META_REDUNDANCY) return null;

  const cell = (bi: number) => {
    const dy = dataStart + Math.floor(bi / META_INNER);
    const dx = dataStart + (bi % META_INNER);
    return bin[dy * META_GRID + dx];
  };

  for (let b = 0; b < bitLen; b++) {
    let votes = 0;
    for (let rep = 0; rep < META_REDUNDANCY; rep++) {
      const bi = rep * bitLen + b;
      if (cell(bi)) votes++;
    }
    bits.push(votes >= Math.ceil(META_REDUNDANCY / 2) ? 1 : 0);
  }

  const payload = bitsToPayload(bits);
  if (!payload || !isValid(payload)) {
    return null;
  }
  return payload;
}

// The metadata payload is fixed-length, so bit length is known a priori.
// (version + algoVersion + magic + pw + ph + w + h + blockSize + crc32 + 4 x crc16)
const FIXED_BIT_LEN = 8 + 8 + 8 + 16 + 16 + 16 + 16 + 8 + 32 + 4 * 16;

function readPayloadLength(
  bin: Uint8Array,
  dataStart: number
): number | null {
  // We know the payload length by construction; validate magic via the first
  // (redundant) copy.
  const inner = META_INNER;
  const cell = (bi: number) => {
    const dy = dataStart + Math.floor(bi / inner);
    const dx = dataStart + (bi % inner);
    return bin[dy * META_GRID + dx];
  };

  let magicVotes = 0;
  for (let rep = 0; rep < META_REDUNDANCY; rep++) {
    let v = 0;
    for (let i = 0; i < 8; i++) v = (v << 1) | cell(rep * FIXED_BIT_LEN + i);
    if (v === META_MAGIC) magicVotes++;
  }
  if (magicVotes < Math.ceil(META_REDUNDANCY / 2)) return null;
  return FIXED_BIT_LEN;
}

// Convenience: default metadata payload for given content + padded canvas.
export function makePayload(
  width: number,
  height: number,
  pq: { pw: number; ph: number },
  checksum: number,
  groupCrcs: number[]
): MetadataPayload {
  return {
    version: VERSION,
    algoVersion: ALGORITHM_VERSION,
    width,
    height,
    pw: pq.pw,
    ph: pq.ph,
    blockSize: BLOCK_SIZE,
    checksum,
    groupCrcs,
  };
}