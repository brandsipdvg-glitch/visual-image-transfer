import { deriveSeed, XorShift128 } from "./rng";
import { crc32, crc16 } from "./crc";
import { quantizeContent, contentGroups, VERIFY_GROUPS } from "./quant";

export const VERSION = 1;
export const ALGORITHM_VERSION = 1;
export const BLOCK_SIZE = 32;

export const PERMUTATIONS = [
  "RGB",
  "RBG",
  "GRB",
  "GBR",
  "BRG",
  "BGR",
] as const;
export type ChannelPermutation = (typeof PERMUTATIONS)[number];

// ---------------------------------------------------------------------------
// Keyed parameters (fully deterministic from the secret key + canvas size)
// ---------------------------------------------------------------------------
export interface KeyedParams {
  permutation: ChannelPermutation;
  kR: number;
  kG: number;
  kB: number;
  maskRng: XorShift128;
  blockPerm: number[];
  pixelPerm: number[];
}

// Padded canvas dims: each side rounded UP to a multiple of BLOCK_SIZE so
// block/pixel scrambling operate over complete 32x32 blocks (exactly
// reversible). The original content is cropped back out after decoding.
export function padDims(width: number, height: number) {
  const pw = Math.max(BLOCK_SIZE, Math.ceil(width / BLOCK_SIZE) * BLOCK_SIZE);
  const ph = Math.max(BLOCK_SIZE, Math.ceil(height / BLOCK_SIZE) * BLOCK_SIZE);
  return { pw, ph };
}

export function buildBlockGrid(pw: number, ph: number, blockSize = BLOCK_SIZE) {
  return { cols: pw / blockSize, rows: ph / blockSize };
}

export async function deriveParams(
  key: string,
  pw: number,
  ph: number
): Promise<KeyedParams> {
  const root = await deriveSeed(key);
  const rng = new XorShift128(root);

  const permIdx = rng.nextU32() % PERMUTATIONS.length;
  const permutation = PERMUTATIONS[permIdx];

  const kR = rng.nextByte();
  const kG = rng.nextByte();
  const kB = rng.nextByte();

  // Independent sub-streams (domain separated). Order here is normative.
  const maskRng = await rng.derive("stage4-mask");
  const blockRng = await rng.derive("stage5-blocks");
  const pixelRng = await rng.derive("stage6-pixels");

  const grid = buildBlockGrid(pw, ph);
  const blockPerm = blockRng.permute(grid.cols * grid.rows);
  const pixelPerm = pixelRng.permute(BLOCK_SIZE * BLOCK_SIZE);

  return { permutation, kR, kG, kB, maskRng, blockPerm, pixelPerm };
}

// ---------------------------------------------------------------------------
// Stage helpers over a Float32Array of size pw*ph*3 (row-major RGB)
// ---------------------------------------------------------------------------
const CH_INDEX: Record<string, number> = { R: 0, G: 1, B: 2 };

export function stage1ChannelPermute(
  arr: Float32Array,
  permutation: ChannelPermutation
): void {
  const order = permutation.split("").map((c) => CH_INDEX[c]);
  for (let i = 0; i < arr.length; i += 3) {
    const src = [arr[i], arr[i + 1], arr[i + 2]];
    arr[i] = src[order[0]];
    arr[i + 1] = src[order[1]];
    arr[i + 2] = src[order[2]];
  }
}

export function stage1Inverse(arr: Float32Array, permutation: ChannelPermutation): void {
  // Applying the *inverse* permutation. Build inverse order.
  const order = permutation.split("").map((c) => CH_INDEX[c]);
  const inv = [0, 0, 0];
  order.forEach((v, idx) => (inv[v] = idx));
  for (let i = 0; i < arr.length; i += 3) {
    const src = [arr[i], arr[i + 1], arr[i + 2]];
    arr[i] = src[inv[0]];
    arr[i + 1] = src[inv[1]];
    arr[i + 2] = src[inv[2]];
  }
}

export function stage2MathTransform(
  arr: Float32Array,
  { kR, kG, kB }: { kR: number; kG: number; kB: number }
): void {
  for (let i = 0; i < arr.length; i += 3) {
    arr[i] = (arr[i] + kR) % 256;
    arr[i + 1] = (arr[i + 1] + kG) % 256;
    arr[i + 2] = (arr[i + 2] + kB) % 256;
  }
}

export function stage2Inverse(arr: Float32Array, p: { kR: number; kG: number; kB: number }): void {
  for (let i = 0; i < arr.length; i += 3) {
    arr[i] = ((arr[i] - p.kR) % 256 + 256) % 256;
    arr[i + 1] = ((arr[i + 1] - p.kG) % 256 + 256) % 256;
    arr[i + 2] = ((arr[i + 2] - p.kB) % 256 + 256) % 256;
  }
}

export function stage3CoordinateTransform(
  arr: Float32Array,
  pw: number
): void {
  for (let y = 0; y < arr.length / (pw * 3); y++) {
    for (let x = 0; x < pw; x++) {
      const i = (y * pw + x) * 3;
      arr[i] = (arr[i] + ((x + y) & 0xff)) % 256;
      arr[i + 1] = (arr[i + 1] + ((2 * x + y) & 0xff)) % 256;
      arr[i + 2] = (arr[i + 2] + ((x + 2 * y) & 0xff)) % 256;
    }
  }
}

export function stage3Inverse(arr: Float32Array, pw: number): void {
  for (let y = 0; y < arr.length / (pw * 3); y++) {
    for (let x = 0; x < pw; x++) {
      const i = (y * pw + x) * 3;
      arr[i] = ((arr[i] - ((x + y) & 0xff)) % 256 + 256) % 256;
      arr[i + 1] = ((arr[i + 1] - ((2 * x + y) & 0xff)) % 256 + 256) % 256;
      arr[i + 2] = ((arr[i + 2] - ((x + 2 * y) & 0xff)) % 256 + 256) % 256;
    }
  }
}

export function stage4Xor(arr: Float32Array, maskRng: XorShift128): void {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = arr[i] ^ maskRng.nextByte();
  }
}

// Stage 5: block scramble. Moves whole 32x32 blocks around; exact permutation.
export function stage5BlockScramble(
  arr: Float32Array,
  pw: number,
  ph: number,
  blockPerm: number[],
  blockSize = BLOCK_SIZE
): Float32Array {
  const cols = pw / blockSize;
  const rows = ph / blockSize;
  const out = new Float32Array(arr.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const src = r * cols + c;
      const dst = blockPerm[src];
      const dr = Math.floor(dst / cols);
      const dc = dst % cols;
      for (let y = 0; y < blockSize; y++) {
        for (let x = 0; x < blockSize; x++) {
          const si = ((r * blockSize + y) * pw + c * blockSize + x) * 3;
          const di = ((dr * blockSize + y) * pw + dc * blockSize + x) * 3;
          out[di] = arr[si];
          out[di + 1] = arr[si + 1];
          out[di + 2] = arr[si + 2];
        }
      }
    }
  }
  return out;
}

// Inverse of stage 5 using the inverse block permutation.
export function stage5Inverse(src: Float32Array, pw: number, ph: number, blockPerm: number[], blockSize = BLOCK_SIZE): Float32Array {
  const inv = new Array<number>(blockPerm.length);
  blockPerm.forEach((d, s) => (inv[d] = s));
  return stage5BlockScramble(src, pw, ph, inv, blockSize);
}

// Stage 6: pixel scramble within every block (same permutation each block).
export function stage6PixelScramble(
  arr: Float32Array,
  pw: number,
  ph: number,
  pixelPerm: number[],
  blockSize = BLOCK_SIZE
): Float32Array {
  const cols = pw / blockSize;
  const rows = ph / blockSize;
  const out = new Float32Array(arr.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (let i = 0; i < blockSize * blockSize; i++) {
        const src = pixelPerm[i];
        const sx = c * blockSize + (src % blockSize);
        const sy = r * blockSize + Math.floor(src / blockSize);
        const dx = c * blockSize + (i % blockSize);
        const dy = r * blockSize + Math.floor(i / blockSize);
        const si = (sy * pw + sx) * 3;
        const di = (dy * pw + dx) * 3;
        out[di] = arr[si];
        out[di + 1] = arr[si + 1];
        out[di + 2] = arr[si + 2];
      }
    }
  }
  return out;
}

// Inverse stage 6: same as stage 6 but with inverse pixel permutation.
export function stage6Inverse(arr: Float32Array, pw: number, ph: number, pixelPerm: number[], blockSize = BLOCK_SIZE): Float32Array {
  const inv = new Array<number>(pixelPerm.length);
  pixelPerm.forEach((d, s) => (inv[d] = s));
  return stage6PixelScramble(arr, pw, ph, inv, blockSize);
}

// ---------------------------------------------------------------------------
// Full encode
// ---------------------------------------------------------------------------
export interface EncodeInput {
  rgba: Uint8ClampedArray; // width*height*4
  width: number;
  height: number;
  key: string;
}

export interface EncodeOutput {
  rgba: Uint8ClampedArray; // pw*ph*4 encoded canvas
  width: number; // original content width
  height: number; // original content height
  pw: number; // padded canvas width (block-aligned)
  ph: number; // padded canvas height (block-aligned)
  key: string;
  checksum: number;
  groupCrcs: number[];
}

export async function encodeImage(input: EncodeInput): Promise<EncodeOutput> {
  const { width, height, key } = input;
  const { pw, ph } = padDims(width, height);
  const params = await deriveParams(key, pw, ph);

  // Populate padded canvas (padding = deterministic pseudorandom so the
  // displayed image has no hard black gutters).
  const fill = new XorShift128(await deriveSeed("pad:" + pw + "x" + ph));
  const arr = new Float32Array(pw * ph * 3);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const i = (y * pw + x) * 3;
      if (x < width && y < height) {
        const s = (y * width + x) * 4;
        arr[i] = input.rgba[s];
        arr[i + 1] = input.rgba[s + 1];
        arr[i + 2] = input.rgba[s + 2];
      } else {
        arr[i] = fill.nextByte();
        arr[i + 1] = fill.nextByte();
        arr[i + 2] = fill.nextByte();
      }
    }
  }

  // Verifiable digests over ORIGINAL content. Quantized to absorb capture
  // noise; per-group CRCs tolerate localized damage (see quant.ts).
  const content = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    content[i * 3] = input.rgba[i * 4];
    content[i * 3 + 1] = input.rgba[i * 4 + 1];
    content[i * 3 + 2] = input.rgba[i * 4 + 2];
  }
  const q = quantizeContent(content);
  const checksum = crc32(q);
  const groupCrcs = contentGroups(q, width, height, 3, VERIFY_GROUPS).map(
    (slice) => crc16(slice)
  );

  // Stage 1
  stage1ChannelPermute(arr, params.permutation);
  // Stage 2
  stage2MathTransform(arr, params);
  // Stage 3
  stage3CoordinateTransform(arr, pw);
  // Stage 4
  stage4Xor(arr, params.maskRng);
  // Stage 5
  const s5 = stage5BlockScramble(arr, pw, ph, params.blockPerm);
  // Stage 6
  const s6 = stage6PixelScramble(s5, pw, ph, params.pixelPerm);

  const out = new Uint8ClampedArray(pw * ph * 4);
  for (let i = 0; i < pw * ph; i++) {
    out[i * 4] = Math.round(s6[i * 3]);
    out[i * 4 + 1] = Math.round(s6[i * 3 + 1]);
    out[i * 4 + 2] = Math.round(s6[i * 3 + 2]);
    out[i * 4 + 3] = 255;
  }

  return { rgba: out, width, height, pw, ph, key, checksum, groupCrcs };
}