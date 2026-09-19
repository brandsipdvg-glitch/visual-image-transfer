// CRC-32 (IEEE) implementation used to validate transfers.
const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  TABLE[n] = c >>> 0;
}

export function crc32(data: Uint8Array | Uint8ClampedArray): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// CRC-16/CCITT-FALSE, used for per-group error-tolerant verification.
export function crc16(data: Uint8Array | Uint8ClampedArray | number[]): number {
  let c = 0xffff;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i] << 8;
    for (let k = 0; k < 8; k++) {
      c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    }
  }
  return c & 0xffff;
}

// CRC-32 over an area of an RGB array with stride (used for checksum mask).
export function crc32RgbArea(
  data: Uint8ClampedArray | Float32Array,
  width: number,
  channels: 3 | 4,
  area: { x: number; y: number; w: number; h: number }
): number {
  let crc = 0xffffffff;
  for (let y = area.y; y < area.y + area.h; y++) {
    for (let x = area.x; x < area.x + area.w; x++) {
      const i = (y * width + x) * channels;
      const v =
        channels === 3
          ? Math.round((data as Float32Array)[i]) & 0xff
          : (data as Uint8ClampedArray)[i];
      crc = TABLE[(crc ^ v) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}