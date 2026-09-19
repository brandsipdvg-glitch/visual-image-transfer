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
  const refinedQuad = refineFrameQuad(rgba, width, height, coarseQuad);
  // Candidate registrations: the marker-refined homography first, then the
  // coarse detected quad. On photographs the coarse quad is occasionally the
  // better one, so both are kept and the one that reads clean metadata wins.
  const cams: { quad: P2[]; toCam: ((p: P2) => P2) | null }[] = [
    { quad: refinedQuad ?? coarseQuad, toCam: refinedQuad ? canonicalToCamera(refinedQuad) : null },
    { quad: coarseQuad, toCam: canonicalToCamera(coarseQuad) },
  ];
  const rects = buildRects(CANONICAL);

  // Collect every registration that yields a valid metadata block. Two meta
  // samplings per quad: whole-cell (robust to small cells) and central-band
  // (robust to sub-cell misregistration).
  const candidates: { quad: P2[]; toCam: (p: P2) => P2; meta: NonNullable<ReturnType<typeof readMetaMatrix>> }[] = [];
  for (const c of cams) {
    if (!c.toCam) continue;
    const metaRectCam = rects.metaRect.map(c.toCam);
    for (const central of [1, 0.6]) {
      const lum = cellLuminanceQuad(rgba, width, height, metaRectCam, META_GRID, 4, central);
      const meta = readMetaMatrix(lum);
      if (meta) candidates.push({ quad: c.quad, toCam: c.toCam, meta });
    }
  }

  if (candidates.length === 0) {
    return {
      status: { stage: "screen", quad: coarseQuad },
      quad: coarseQuad,
      refined: refinedQuad !== null,
    };
  }

  // Decode with each working registration until one verifies cleanly.
  for (const cand of candidates) {
    const dataRectCam = rects.dataRect.map(cand.toCam);
    const data = renderRect(
      rgba,
      width,
      height,
      dataRectCam,
      cand.meta.pw,
      cand.meta.ph,
      { supersample: 2 }
    );
    const result: DecodeResult = await decodeImage({
      rgba: data,
      pw: cand.meta.pw,
      ph: cand.meta.ph,
      key,
      checksum: cand.meta.checksum,
      groupCrcs: cand.meta.groupCrcs,
      width: cand.meta.width,
      height: cand.meta.height,
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
        quad: cand.quad,
        refined: refinedQuad !== null,
      };
    }
  }

  return {
    status: { stage: "failed", reason: "checksum-mismatch" },
    quad: refinedQuad ?? coarseQuad,
    refined: refinedQuad !== null,
  };
}

export { GEOM, CANONICAL };