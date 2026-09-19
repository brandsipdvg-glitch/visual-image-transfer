// Decode worker: detect + read metadata + decode a camera frame.
// Shared state lives here so consecutive frames reuse nothing but ordering.
import { processFrame } from "../receiver";
import { transferClone } from "../imageData";
import type {
  DecodeFrameRequest,
  DecodeStageStatus,
  DecodeStatusMessage,
  DecodeResultMessage,
} from "./types";

let busy = false;

self.onmessage = async (ev: MessageEvent<DecodeFrameRequest>) => {
  const req = ev.data;
  if (req.type !== "frame") return;
  // Always ack so the main thread can release its in-flight flag — even when a
  // previous frame is still processing (that frame is simply dropped).
  if (busy) {
    (self as unknown as Worker).postMessage({ type: "busy" });
    return;
  }
  busy = true;
  try {
    const status = await processFrame({
      rgba: new Uint8ClampedArray(req.rgba),
      width: req.width,
      height: req.height,
      key: req.key,
    });

    if (status.stage === "decoded") {
      const res: DecodeResultMessage = {
        type: "decoded",
        rgba: transferClone(status.result.rgba),
        width: status.result.width,
        height: status.result.height,
        quality: status.result.quality,
      };
      (self as unknown as Worker).postMessage(res, [res.rgba]);
      return;
    }

    const msg: DecodeStatusMessage = { type: "status", status: serializeStatus(status) };
    (self as unknown as Worker).postMessage(msg);
  } catch {
    const msg: DecodeStatusMessage = { type: "status", status: { stage: "failed", reason: "decode-exception" } };
    (self as unknown as Worker).postMessage(msg);
  } finally {
    busy = false;
  }
};

function serializeStatus(status: Awaited<ReturnType<typeof processFrame>>): DecodeStageStatus {
  const quad = (q?: { x: number; y: number }[]) =>
    q ? q.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })) : null;
  switch (status.stage) {
    case "scanning":
      return { stage: "scanning" as const };
    case "screen":
      return { stage: "screen" as const, quad: quad(status.quad) };
    case "reading-meta":
      return { stage: "reading-meta" as const, quad: quad(status.quad) };
    case "decoding":
      return {
        stage: "decoding" as const,
        quad: quad(status.quad),
        meta: {
          pw: status.meta.pw,
          ph: status.meta.ph,
          width: status.meta.width,
          height: status.meta.height,
        },
      };
    case "failed":
      return { stage: "failed" as const, reason: status.reason };
    default:
      return { stage: "scanning" as const };
  }
}

export default {};