// Build an ImageData from any Uint8ClampedArray (TS 5.7+/lib.dom types
// Uint8ClampedArray<ArrayBufferLike> which no longer assignable to ImageData's
// required ArrayBuffer-backed parameter). Copies the bytes into a fresh buffer.
export function wrapImageData(data: Uint8ClampedArray, w: number, h: number): ImageData {
  return new ImageData(new Uint8ClampedArray(data), w, h);
}

// Slice+copy a buffer so it can be used in a postMessage transfer list (the
// source may be backed by ArrayBufferLike in the type system).
export function transferClone(data: Uint8ClampedArray): ArrayBuffer {
  return data.buffer.slice(0) as ArrayBuffer;
}