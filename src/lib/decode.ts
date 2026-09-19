import {
  BLOCK_SIZE,
  stage1Inverse,
  stage2Inverse,
  stage3Inverse,
  stage4Xor,
  stage5Inverse,
  stage6Inverse,
  deriveParams,
} from "./encode";
import { crc32, crc16 } from "./crc";
import { quantizeContent, contentGroups, VERIFY_GROUPS, VERIFY_MIN_MATCH } from "./quant";

export interface DecodeInput {
  rgba: Uint8ClampedArray; // pw*ph*4 captured/registered encoded canvas
  pw: number; // padded canvas width (from metadata)
  ph: number; // padded canvas height (from metadata)
  key: string;
  checksum: number; // expected CRC32 of quantized original content
  groupCrcs: number[]; // 4x CRC16 of quantized content slices
  width: number; // original content width
  height: number; // original content height
}

export type DecodeResult =
  | { ok: true; rgba: Uint8ClampedArray; width: number; height: number; quality: number }
  | { ok: false; reason: DecodeError };

export type DecodeError =
  | "checksum-mismatch"
  | "invalid-dims"
  | "decode-exception";

// Verify the recovered content against the stored digests. Returns match
// percentage 0..1, 1 meaning exact (quantized) match for the full image.
export function verifyRecovered(
  content: Uint8Array, // RGB, width*height*3
  width: number,
  height: number,
  checksum: number,
  groupCrcs: number[]
): number {
  const q = quantizeContent(content);
  if (crc32(q) === checksum) return 1;
  const slices = contentGroups(q, width, height, 3, VERIFY_GROUPS);
  let matching = 0;
  for (let g = 0; g < slices.length; g++) {
    if (crc16(slices[g]) === groupCrcs[g]) matching++;
  }
  return matching >= VERIFY_MIN_MATCH ? matching / slices.length : 0;
}

export async function decodeImage(input: DecodeInput): Promise<DecodeResult> {
  const { pw, ph, key, width, height, checksum, groupCrcs } = input;
  if (
    !Number.isInteger(pw) ||
    !Number.isInteger(ph) ||
    pw <= 0 ||
    ph <= 0 ||
    pw % BLOCK_SIZE !== 0 ||
    ph % BLOCK_SIZE !== 0 ||
    width <= 0 ||
    height <= 0 ||
    width > pw ||
    height > ph
  ) {
    return { ok: false, reason: "invalid-dims" };
  }

  try {
    const params = await deriveParams(key, pw, ph);
    const arr = new Float32Array(pw * ph * 3);
    for (let i = 0; i < pw * ph; i++) {
      arr[i * 3] = input.rgba[i * 4];
      arr[i * 3 + 1] = input.rgba[i * 4 + 1];
      arr[i * 3 + 2] = input.rgba[i * 4 + 2];
    }

    // Reverse stages in exact reverse order.
    const s5 = stage6Inverse(arr, pw, ph, params.pixelPerm);
    const s0 = stage5Inverse(s5, pw, ph, params.blockPerm);
    stage4Xor(s0, params.maskRng);
    stage3Inverse(s0, pw);
    stage2Inverse(s0, params);
    stage1Inverse(s0, params.permutation);

    // Recompose content over ORIGINAL content (crop to width x height).
    const content = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * pw + x) * 3;
        content[(y * width + x) * 3] = Math.round(s0[i]);
        content[(y * width + x) * 3 + 1] = Math.round(s0[i + 1]);
        content[(y * width + x) * 3 + 2] = Math.round(s0[i + 2]);
      }
    }

    const match = verifyRecovered(content, width, height, checksum, groupCrcs ?? []);
    if (match <= 0) {
      return { ok: false, reason: "checksum-mismatch" };
    }

    const out = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      out[i * 4] = content[i * 3];
      out[i * 4 + 1] = content[i * 3 + 1];
      out[i * 4 + 2] = content[i * 3 + 2];
      out[i * 4 + 3] = 255;
    }
    return { ok: true, rgba: out, width, height, quality: match };
  } catch (e) {
    return { ok: false, reason: "decode-exception" };
  }
}