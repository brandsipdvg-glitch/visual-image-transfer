// Message contract between the UI thread and the encode/decode workers.

export interface EncodeRequest {
  type: "encode";
  // RGBA of the original image (w*h*4).
  rgba: ArrayBuffer;
  width: number;
  height: number;
  key: string;
}

export interface EncodeResponse {
  type: "encoded";
  // Encoded padded RGBA canvas (pw*ph*4).
  rgba: ArrayBuffer;
  width: number; // original content width
  height: number; // original content height
  pw: number; // padded canvas width
  ph: number; // padded canvas height
  checksum: number;
  groupCrcs: number[];
}

export interface DecodeFrameRequest {
  type: "frame";
  rgba: ArrayBuffer; // camera RGBA (width*height*4)
  width: number;
  height: number;
  key: string;
}

export type DecodeStageStatus =
  | { stage: "scanning" }
  | { stage: "screen"; quad?: { x: number; y: number }[] | null }
  | {
      stage: "reading-meta";
      quad?: { x: number; y: number }[] | null;
      dataRect?: { x: number; y: number }[] | null;
      metaRect?: { x: number; y: number }[] | null;
    }
  | {
      stage: "decoding";
      quad?: { x: number; y: number }[] | null;
      dataRect?: { x: number; y: number }[] | null;
      metaRect?: { x: number; y: number }[] | null;
      meta?: { pw: number; ph: number; width: number; height: number };
    }
  | { stage: "decoded"; width: number; height: number; quality: number }
  | { stage: "failed"; reason: string };

export interface DecodeStatusMessage {
  type: "status";
  status: DecodeStageStatus;
}

export interface DecodeResultMessage {
  type: "decoded";
  // RGBA of the recovered ORIGINAL content (width*height*4).
  rgba: ArrayBuffer;
  width: number;
  height: number;
  quality: number;
}