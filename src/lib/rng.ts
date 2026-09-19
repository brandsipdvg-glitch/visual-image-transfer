// Deterministic PRNG + key derivation utilities.
// All scrambling is deterministic given the secret key so decoding can fully
// reverse every stage.

export const MASK64 = (1n << 64n) - 1n;

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return new Uint8Array(buf);
}

// Derive a 256-bit keyed seed from the textual secret.
export async function deriveSeed(
  key: string,
  domain = "visual-image-transfer"
): Promise<Uint8Array> {
  const enc = new TextEncoder().encode(domain + "::" + key);
  return await sha256(enc);
}

// xorshift128+ (BigInt backed, deterministic, fast enough for our sizes).
export class XorShift128 {
  private s0: bigint;
  private s1: bigint;

  constructor(seed: Uint8Array) {
    let a = 0n;
    let b = 0n;
    for (let i = 7; i >= 0; i--) a = (a << 8n) | BigInt(seed[i]);
    for (let i = 15; i >= 8; i--) b = (b << 8n) | BigInt(seed[i]);
    if (a === 0n) a = 1n;
    if (b === 0n) b = 1n;
    this.s0 = a & MASK64;
    this.s1 = b & MASK64;
  }

  private next64(): bigint {
    let s1 = this.s0;
    const s0 = this.s1;
    this.s0 = s0;
    s1 ^= (s1 << 23n) & MASK64;
    this.s1 = (s1 ^ s0 ^ (s1 >> 17n) ^ (s0 >> 26n)) & MASK64;
    return (this.s1 + s0) & MASK64;
  }

  nextU32(): number {
    return Number(this.next64() & 0xffffffffn) >>> 0;
  }

  // Float in [0,1)
  next01(): number {
    return Number(this.next64() >> 11n) * (1 / 9007199254740992);
  }

  nextByte(): number {
    return this.nextU32() & 0xff;
  }

  // Derive an independent sub-stream (domain separation). CRITICAL: must be
  // called in the same order from encoder and decoder.
  async derive(domain: string): Promise<XorShift128> {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 4; i++) {
      const v = this.nextU32();
      bytes[i * 4] = v & 0xff;
      bytes[i * 4 + 1] = (v >> 8) & 0xff;
      bytes[i * 4 + 2] = (v >> 16) & 0xff;
      bytes[i * 4 + 3] = (v >> 24) & 0xff;
    }
    const seed = await sha256(
      new TextEncoder().encode("substream:" + domain)
    );
    const mixed = new Uint8Array(16);
    for (let i = 0; i < 16; i++) mixed[i] = seed[i] ^ bytes[i];
    return new XorShift128(mixed);
  }

  // Fisher-Yates shuffle; returns a NEW array of indices 0..n-1 permuted.
  permute(n: number): number[] {
    const arr = new Array<number>(n);
    for (let i = 0; i < n; i++) arr[i] = i;
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(this.next01() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }
}

export function shuffleIndices(n: number, rng: XorShift128): number[] {
  return rng.permute(n);
}