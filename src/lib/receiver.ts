// Receiver pipeline: camera frame -> decode. Called for every captured frame.
import { CANONICAL, GEOM, buildRects } from "./compose";
import { detectFrame } from "./detect";
import {
  applyH,
  cellLuminanceQuad,
  getPerspectiveTransform,
  renderRect,
  type P2,
} from "./warp";
import { META_GRID, readMetaMatrix } from "./meta";
import { decodeImage, type DecodeResult } from "./decode";
import { refineFrameQuad } from "./finder";

export type FrameStatus =
  | { stage: "scanning" }
  | {
      stage: "screen";
      quad: P2[];
    }
  | {
      stage: "reading-meta";
      quad: P2[];
    }
  | {
      stage: "decoding";
      quad: P2[];
      meta: {
        pw: number;
        ph: number;
        width: number;
        height: number;
        checksum: number;
        groupCrcs: number[];
      };
    }
  | {
      stage: "decoded";
      result: { rgba: Uint8ClampedArray; width: number; height: number; quality: number };
    }
  | { stage: "failed"; reason: string };

export interface ProcessFrameInput {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  key: string;
}

// Canonical rects (camera-space quads) derived from the detected frame. Returned
// so the UI can draw a debug overlay.
export interface StageGeometry {
  quad: P2[]; // frame in camera coords
  dataRect: P2[]; // data rect in camera coords
  metaRect: P2[]; // meta block in camera coords
}

function canonicalToCamera(quad: P2[]): (p: P2) => P2 {
  const square: P2[] = [
    { x: 0, y: 0 },
    { x: CANONICAL, y: 0 },
    { x: CANONICAL, y: CANONICAL },
    { x: 0, y: CANONICAL },
  ];
  const Hc = getPerspectiveTransform(square, quad);
  return (p) => applyH(Hc, p);
}

export async function processFrame(
  input: ProcessFrameInput
): Promise<FrameStatus> {
  const { rgba, width, height, key } = input;
  const det = detectFrame(rgba, width, height);
  if (!det) return { stage: "scanning" };
  const { status } = await processFrameWithQuad(
    { ...input, width, height, key },
    det.quad
  );
  return status;
}

// Process a frame using a supplied (possibly coarse) frame quad instead of
// running detection. Refines it via the QR markers when possible and reports
// which quad was actually used — handy for tests and debug overlays.
export async function processFrameWithQuad(
  input: ProcessFrameInput,
  coarseQuad: P2[]
): Promise<{ status: FrameStatus; quad: P2[]; refined: boolean }> {
  const { rgba, width, height, key } = input;
  return processInner(rgba, width, height, key, coarseQuad);
}

async function processInner(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  key: string,
  coarseQuad: P2[]
): Promise<{ status: FrameStatus; quad: P2[]; refined: boolean }> {
  // Register the frame sub-pixel using the QR finder markers; fall back to the
  // coarse white-frame quad when the markers are not found (e.g. old captures).
  const refinedQuad = refineFrameQuad(rgba, width, height, coarseQuad);
  const toCam = canonicalToCamera(refinedQuad ?? coarseQuad);
  const rects = buildRects(CANONICAL);
  const dataRectCam = rects.dataRect.map(toCam);
  const metaRectCam = rects.metaRect.map(toCam);

  // Read metadata directly from the quad (homography-sampled per-cell averages,
  // robust against perspective distortion, blur, and block-edge bleed).
  const lum = cellLuminanceQuad(rgba, width, height, metaRectCam, META_GRID, 4);
  const meta = readMetaMatrix(lum);

  if (!meta) {
    return { status: { stage: "screen", quad: coarseQuad }, quad: refinedQuad ?? coarseQuad, refined: refinedQuad !== null };
  }

  // Register the data rect into the padded canvas and decode. Supersampling
  // area-averages several sensor pixels per content cell, suppressing the
  // per-pixel noise that otherwise flips a cell's quantized value.
  const data = renderRect(
    rgba,
    width,
    height,
    dataRectCam,
    meta.pw,
    meta.ph,
    { supersample: 2 }
  );

  const result: DecodeResult = await decodeImage({
    rgba: data,
    pw: meta.pw,
    ph: meta.ph,
    key,
    checksum: meta.checksum,
    groupCrcs: meta.groupCrcs,
    width: meta.width,
    height: meta.height,
  });

  if (result.ok) {
    return {
      status: {
        stage: "decoded",
        result: {
          rgba: result.rgba,
          width: result.width,
          height: result.height,
          quality: result.quality,
        },
      },
      quad: refinedQuad ?? coarseQuad,
      refined: refinedQuad !== null,
    };
  }
  return {
    status: { stage: "failed", reason: result.reason },
    quad: refinedQuad ?? coarseQuad,
    refined: refinedQuad !== null,
  };
}

export { GEOM, CANONICAL };