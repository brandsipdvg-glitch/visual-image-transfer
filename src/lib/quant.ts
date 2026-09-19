// Quantization for the error-tolerant transfer digest.
//
// Real camera/compression introduces small per-channel errors, so a byte-exact
// CRC over the original content is not verifiable. We instead checksum a 4-bit
// (top-half) quantization of the RGB content: quantization absorbs noise up to
// ~7/255 per channel, and per-group CRC16 digests let a handful of damaged
// regions be tolerated. The receiver still delivers the unquantized recovered
// pixels; the digest is only a verification gate.
export function quantizeContent(content: Uint8Array | Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(content.length);
  for (let i = 0; i < content.length; i++) {
    out[i] = content[i] & 0xf0;
  }
  return out;
}

// Split the (quantized) content into GROUPS vertical slices and hash each one.
// Accepting when >= MIN_MATCH groups agree tolerates localized capture damage
// while still rejecting wrong keys / gross failures.
export const VERIFY_GROUPS = 4;
export const VERIFY_MIN_MATCH = 3;

export function contentGroups(
  content: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: number,
  groups: number
): Uint8Array[] {
  const out: Uint8Array[] = [];
  const ys = Math.ceil(height / groups);
  for (let g = 0; g < groups; g++) {
    const y0 = g * ys;
    const y1 = Math.min(height, y0 + ys);
    const slice: number[] = [];
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * channels;
        for (let c = 0; c < channels; c++) slice.push(content[i + c]);
      }
    }
    out.push(new Uint8Array(slice));
  }
  return out;
}