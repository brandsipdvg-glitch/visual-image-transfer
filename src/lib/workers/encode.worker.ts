// Encode worker: runs the (async, CPU-heavy) keyed scramble off the UI thread.
import { encodeImage } from "../encode";
import { transferClone } from "../imageData";
import type { EncodeRequest, EncodeResponse } from "./types";

self.onmessage = async (ev: MessageEvent<EncodeRequest>) => {
  const req = ev.data;
  if (req.type !== "encode") return;
  try {
    const result = await encodeImage({
      rgba: new Uint8ClampedArray(req.rgba),
      width: req.width,
      height: req.height,
      key: req.key,
    });
    const res: EncodeResponse = {
      type: "encoded",
      rgba: transferClone(result.rgba),
      width: result.width,
      height: result.height,
      pw: result.pw,
      ph: result.ph,
      checksum: result.checksum,
      groupCrcs: result.groupCrcs,
    };
    (self as unknown as Worker).postMessage(res, [res.rgba]);
  } catch (e) {
    (self as unknown as Worker).postMessage({
      type: "error",
      message: e instanceof Error ? e.message : String(e),
    });
  }
};

export default {};