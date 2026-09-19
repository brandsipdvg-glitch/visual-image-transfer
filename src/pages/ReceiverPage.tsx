import { useCallback, useEffect, useRef, useState } from "react";
import DecodeWorker from "../lib/workers/decode.worker?worker";
import { wrapImageData, transferClone } from "../lib/imageData";
import type {
  DecodeResultMessage,
  DecodeStageStatus,
  DecodeStatusMessage,
} from "../lib/workers/types";

const CAP_WIDTH = 1280;

export function ReceiverPage() {
  const workerRef = useRef<InstanceType<typeof DecodeWorker> | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const captureRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pendingRef = useRef(false);
  const rafRef = useRef<number>(0);
  const statusRef = useRef<DecodeStageStatus>({ stage: "scanning" });

  const [key, setKey] = useState(() => localStorage.getItem("vit-key") ?? "");
  const [running, setRunning] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const [status, setStatus] = useState<DecodeStageStatus>({ stage: "scanning" });
  const [result, setResult] = useState<{ width: number; height: number; quality: number; rgba: Uint8ClampedArray } | null>(null);

  useEffect(() => {
    localStorage.setItem("vit-key", key);
  }, [key]);

  const drawOverlay = useCallback(() => {
    const c = overlayRef.current;
    const v = videoRef.current;
    if (!c || !v) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(v.clientWidth * dpr));
    c.height = Math.max(1, Math.round(v.clientHeight * dpr));
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);

    const sx = c.width / v.clientWidth;
    const sy = c.height / v.clientHeight;

    // Scale quad coords (capture space) onto the overlay space.
    const capW = captureRef.current?.width ?? 0;
    const capH = captureRef.current?.height ?? 0;
    const qx = capW ? (c.width / capW) * sx : 1;
    const qy = capH ? (c.height / capH) * sy : 1;

    const st = statusRef.current;
    const quads =
      st.stage === "screen" ||
      st.stage === "reading-meta" ||
      st.stage === "decoding"
        ? st.quad
        : null;
    if (quads && quads.length === 4) {
      ctx.beginPath();
      ctx.moveTo(quads[0].x * qx, quads[0].y * qy);
      for (let i = 1; i < 4; i++) ctx.lineTo(quads[i].x * qx, quads[i].y * qy);
      ctx.closePath();
      ctx.strokeStyle = "rgba(76,141,255,0.9)";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }, []);

  useEffect(() => {
    if (!running) return;
    const id = requestAnimationFrame(drawOverlay);
    const onResize = () => drawOverlay();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("resize", onResize);
    };
  }, [running, drawOverlay]);

  useEffect(() => {
    workerRef.current = new DecodeWorker();
    const w = workerRef.current;
    const onMsg = (ev: MessageEvent<DecodeStatusMessage | DecodeResultMessage | { type: "busy" }>) => {
      const d = ev.data;
      if (d.type === "busy") {
        pendingRef.current = false;
        return;
      }
      if (d.type === "decoded") {
        setResult({
          rgba: new Uint8ClampedArray(d.rgba),
          width: d.width,
          height: d.height,
          quality: d.quality,
        });
        setStatus({ stage: "decoded", width: d.width, height: d.height, quality: d.quality });
        pendingRef.current = false;
        return;
      }
      statusRef.current = d.status;
      setStatus(d.status);
      pendingRef.current = false;
    };
    w.addEventListener("message", onMsg);
    return () => {
      w.removeEventListener("message", onMsg);
      w.terminate();
    };
  }, []);

  const capture = useCallback(() => {
    const v = videoRef.current;
    const cap = captureRef.current;
    const w = workerRef.current;
    if (!v || !cap || !w || pendingRef.current) return;
    if (v.readyState < 2 || !v.videoWidth) return;

    const scale = Math.min(1, CAP_WIDTH / v.videoWidth);
    const cw = Math.max(2, Math.round(v.videoWidth * scale));
    const ch = Math.max(2, Math.round(v.videoHeight * scale));
    if (cap.width !== cw) cap.width = cw;
    if (cap.height !== ch) cap.height = ch;
    const ctx = cap.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, cw, ch);
    const img = ctx.getImageData(0, 0, cw, ch);
    const buf = transferClone(img.data);
    pendingRef.current = true;
    w.postMessage({ type: "frame", rgba: buf, width: cw, height: ch, key }, [buf]);
  }, [key]);

  useEffect(() => {
    if (!running) return;
    const loop = () => {
      capture();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [running, capture]);

  async function startCamera() {
    setCamError(null);
    setResult(null);
    setStatus({ stage: "scanning" });
    statusRef.current = { stage: "scanning" };
    if (!window.isSecureContext) {
      setCamError(
        "Blocked: camera requires a secure context. Open this page over HTTPS (or localhost), not plain HTTP."
      );
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamError("Camera API unavailable in this browser.");
      return;
    }
    try {
      const stream = requestCameraStream();
      // Let streams abort if the component unmounts mid-request.
      const timeout = setTimeout(() => {
        void stream.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
      }, 25000);
      const s = await stream;
      clearTimeout(timeout);
      streamRef.current = s;
      const v = videoRef.current;
      if (!v) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      v.srcObject = s;
      await v.play();
      if (!v.videoWidth) {
        await new Promise<void>((resolve) => {
          v.addEventListener("loadedmetadata", () => resolve(), { once: true });
          setTimeout(resolve, 2000);
        });
      }
      setRunning(true);
    } catch (e) {
      setCamError(
        "Camera unavailable or permission denied. " +
          (e instanceof Error ? e.message : String(e)) +
          " — allow camera access, or try mirroring the back camera on your phone."
      );
    }
  }

  function requestCameraStream(): Promise<MediaStream> {
    const backCam = {
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1440 },
      },
      audio: false,
    };
    const anyCam = { video: { width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false };
    return navigator.mediaDevices.getUserMedia(backCam).catch((err: DOMException) => {
      if (err.name === "OverconstrainedError" || err.name === "NotFoundError" || err.name === "TypeError") {
        return navigator.mediaDevices.getUserMedia(anyCam);
      }
      throw err;
    });
  }

  function stopCamera() {
    setRunning(false);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const v = videoRef.current;
    if (v) v.srcObject = null;
  }

  useEffect(() => {
    return () => {
      setRunning(false);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  function reset() {
    stopCamera();
    setResult(null);
    setStatus({ stage: "scanning" });
    statusRef.current = { stage: "scanning" };
  }

  const stageColor =
    status.stage === "decoded" ? "var(--ok)" : status.stage === "failed" ? "var(--err)" : "var(--accent-2)";

  return (
    <main style={{ minHeight: "100%", display: "flex", flexDirection: "column", padding: 24, maxWidth: 860, margin: "0 auto", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <a href="#/" className="muted" style={{ fontSize: "0.9rem" }}>
          Home
        </a>
        <h2 style={{ margin: 0, fontSize: "1.15rem" }}>Receive with camera</h2>
        <span style={{ flex: 1 }} />
        {running && (
          <button onClick={stopCamera} className="ghost">
            Stop
          </button>
        )}
      </header>

      <div style={{ display: "flex", gap: 12, alignItems: "end" }}>
        <div style={{ flex: 1 }}>
          <label htmlFor="rkey" className="muted" style={{ display: "block", marginBottom: 6, fontSize: "0.9rem" }}>
            Secret key (same as sender)
          </label>
          <input
            id="rkey"
            type="password"
            value={key}
            placeholder="shared passphrase"
            onChange={(e) => setKey(e.target.value)}
            disabled={running}
          />
        </div>
        <button className="primary" disabled={running} onClick={() => void startCamera()}>
          Start camera
        </button>
      </div>

      {camError && <p style={{ color: "var(--err)", margin: 0 }}>{camError}</p>}

      <section
        style={{
          position: "relative",
          aspectRatio: "4 / 3",
          maxHeight: "62vh",
          width: "100%",
          background: "#000",
          borderRadius: 14,
          overflow: "hidden",
          border: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {!running ? (
          <div style={{ textAlign: "center", color: "var(--text-dim)", padding: 20 }}>
            Camera is off. Start it and point it at the sender&apos;s fullscreen frame.
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
            <canvas
              ref={overlayRef}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
            />
            <div
              style={{
                position: "absolute",
                top: 12,
                left: 12,
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: "0.8rem",
                background: "rgba(0,0,0,0.55)",
                padding: "5px 10px",
                borderRadius: 999,
                color: stageColor,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: stageColor,
                  display: "inline-block",
                }}
              />
              <span>{stageLabel(status)}</span>
            </div>
            {status.stage === "scanning" && (
              <div className="muted" style={{ position: "absolute", bottom: 12, left: 12, fontSize: "0.8rem" }}>
                No screen detected — move the camera until the white frame is visible.
              </div>
            )}
            {status.stage === "failed" && (
              <div style={{ position: "absolute", bottom: 12, left: 12, fontSize: "0.8rem", color: "var(--warn)" }}>
                Decode failed ({status.reason}) — keep frame steady, check the key.
              </div>
            )}
          </>
        )}

        {result && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(6,8,12,0.82)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 14,
              padding: 20,
            }}
          >
            <div style={{ fontSize: "0.9rem", color: "var(--ok)", fontWeight: 600 }}>
              Decoded — {(result.quality * 100).toFixed(0)}% match
            </div>
            <canvas
              style={{
                maxWidth: "92%",
                maxHeight: "52vh",
                borderRadius: 10,
                boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
                background: "#000",
              }}
              ref={(el) => {
                if (!el) return;
                el.width = result.width;
                el.height = result.height;
                el.getContext("2d")?.putImageData(
                  wrapImageData(result.rgba, result.width, result.height),
                  0,
                  0
                );
              }}
            />
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={reset} className="primary">
                Scan again
              </button>
              <button onClick={() => setResult(null)} className="ghost">
                Close
              </button>
            </div>
          </div>
        )}
      </section>

      <p className="muted" style={{ fontSize: "0.8rem", margin: 0 }}>
        Tip: keep the whole white frame in view, avoid glare, and hold steady for a second or
        two. Detection runs continuously.
      </p>
      <canvas ref={captureRef} hidden />
    </main>
  );
}

function stageLabel(s: DecodeStageStatus): string {
  switch (s.stage) {
    case "scanning":
      return "scanning…";
    case "screen":
      return "screen detected";
    case "reading-meta":
      return "reading metadata…";
    case "decoding":
      return "decoding…";
    case "decoded":
      return "decoded";
    case "failed":
      return "decode failed";
  }
}