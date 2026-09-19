import { useEffect, useRef, useState } from "react";
import EncodeWorker from "../lib/workers/encode.worker?worker";
import type { EncodeResponse } from "../lib/workers/types";
import { composeDisplay } from "../lib/compose";
import { buildMetaMatrix, makePayload } from "../lib/meta";
import { wrapImageData, transferClone } from "../lib/imageData";

const MAX_DIM = 320;

interface Encoded {
  rgba: Uint8ClampedArray;
  pw: number;
  ph: number;
  width: number;
  height: number;
  checksum: number;
  groupCrcs: number[];
}

function loadImageBytes(file: File): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return reject(new Error("no 2d context"));
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      resolve({ rgba: new Uint8ClampedArray(data), width: w, height: h });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("could not load image"));
    };
    img.src = url;
  });
}

export function SenderPage() {
  const workerRef = useRef<InstanceType<typeof EncodeWorker> | null>(null);
  const srcCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fsWrapRef = useRef<HTMLDivElement | null>(null);
  const fsCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [key, setKey] = useState(() => localStorage.getItem("vit-key") ?? "");
  const [src, setSrc] = useState<{ width: number; height: number } | null>(null);
  const [encoded, setEncoded] = useState<Encoded | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    workerRef.current = new EncodeWorker();
    const w = workerRef.current;
    const onMsg = (ev: MessageEvent<EncodeResponse>) => {
      const r = ev.data;
      if (r.type !== "encoded") return;
      setEncoded({
        rgba: new Uint8ClampedArray(r.rgba),
        pw: r.pw,
        ph: r.ph,
        width: r.width,
        height: r.height,
        checksum: r.checksum,
        groupCrcs: r.groupCrcs,
      });
      setBusy(false);
    };
    w.addEventListener("message", onMsg);
    return () => {
      w.removeEventListener("message", onMsg);
      w.terminate();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("vit-key", key);
  }, [key]);

  async function pickFile(file: File) {
    try {
      setErr(null);
      const { rgba, width, height } = await loadImageBytes(file);
      const c = srcCanvasRef.current;
      const ctx = c?.getContext("2d");
      if (c && ctx) {
        c.width = width;
        c.height = height;
        ctx.putImageData(wrapImageData(rgba, width, height), 0, 0);
      }
      setSrc({ width, height });
      setEncoded(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed to load image");
    }
  }

  const handleFile = (ev: React.ChangeEvent<HTMLInputElement>) => {
    const f = ev.target.files?.[0];
    if (f) void pickFile(f);
    ev.target.value = "";
  };

  const onDrop = (ev: React.DragEvent) => {
    ev.preventDefault();
    setDragOver(false);
    const f = ev.dataTransfer.files?.[0];
    if (f) void pickFile(f);
  };

  useEffect(() => {
    const onPaste = (ev: ClipboardEvent) => {
      const item = Array.from(ev.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      const f = item?.getAsFile();
      if (f) void pickFile(f);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doEncode() {
    if (!src || !key) return;
    setErr(null);
    setBusy(true);
    setEncoded(null);
    const w = workerRef.current;
    if (!w) return;
    const c = srcCanvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
    const buf = transferClone(rgba);
    w.postMessage({ type: "encode", rgba: buf, width: c.width, height: c.height, key }, [buf]);
  }

  function renderDisplay(
    canvas: HTMLCanvasElement | null,
    enc: Encoded,
    winW: number,
    winH: number
  ) {
    if (!canvas) return;
    const mat = buildMetaMatrix(
      makePayload(enc.width, enc.height, { pw: enc.pw, ph: enc.ph }, enc.checksum, enc.groupCrcs)
    );
    const display = composeDisplay(enc.rgba, enc.pw, enc.ph, mat, winW, winH);
    canvas.width = winW;
    canvas.height = winH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(wrapImageData(display, winW, winH), 0, 0);
  }

  useEffect(() => {
    if (!encoded) return;
    const c = displayCanvasRef.current;
    if (!c || fullscreen) return;
    const el = c.parentElement;
    const w = el?.clientWidth ?? 640;
    const h = el?.clientHeight ?? 480;
    renderDisplay(c, encoded, w, h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encoded, fullscreen]);

  useEffect(() => {
    if (!fullscreen || !encoded) return;
    const c = fsCanvasRef.current;
    if (!c) return;

    const render = () => {
      renderDisplay(c, encoded, window.innerWidth, window.innerHeight);
    };
    render();
    const onResize = () => render();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [fullscreen, encoded]);

  async function enterFullscreen() {
    if (!encoded) return;
    setFullscreen(true);
    const el = fsWrapRef.current;
    if (el && !document.fullscreenElement) {
      try {
        await el.requestFullscreen();
      } catch {
        // Fullscreen may be unavailable (e.g. embedded iframe); mirror is fine.
      }
    }
  }

  function exitFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    setFullscreen(false);
  }

  if (fullscreen && encoded) {
    return (
      <div
        ref={fsWrapRef}
        style={{
          position: "fixed",
          inset: 0,
          background: "#000",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <canvas ref={fsCanvasRef} style={{ width: "100%", height: "100%" }} />
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 14px",
            background: "rgba(0,0,0,0.55)",
            backdropFilter: "blur(6px)",
            fontSize: "0.85rem",
          }}
        >
          <span className="muted">
            Point the receiver at this screen, fully zoomed, all four corners visible.
          </span>
          <button onClick={exitFullscreen} className="ghost">
            Exit
          </button>
        </div>
      </div>
    );
  }

  return (
    <main style={{ minHeight: "100%", padding: 24, maxWidth: 860, margin: "0 auto" }}>
      <header style={{ marginBottom: 18, display: "flex", alignItems: "center", gap: 12 }}>
        <a href="#/" className="muted" style={{ fontSize: "0.9rem" }}>
          Home
        </a>
        <h2 style={{ margin: 0, fontSize: "1.15rem" }}>Send an image</h2>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <section className="card">
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              border: "1.5px dashed",
              borderColor: dragOver ? "var(--accent)" : "var(--border)",
              borderRadius: 10,
              padding: "2rem 1rem",
              cursor: "pointer",
            }}
            onClick={() => document.getElementById("file-input")?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            {src ? (
              <canvas
                ref={srcCanvasRef}
                style={{ maxWidth: "100%", maxHeight: 220, borderRadius: 8 }}
              />
            ) : (
              <span className="muted" style={{ textAlign: "center" }}>
                Drop, paste, or click to choose an image
                <br />
                <span className="mono" style={{ fontSize: "0.75rem" }}>
                  max {MAX_DIM}px, JPEG/PNG/GIF/WebP
                </span>
              </span>
            )}
            <input id="file-input" type="file" accept="image/*" hidden onChange={handleFile} />
          </div>

          {src && (
            <p className="muted mono" style={{ fontSize: "0.8rem", margin: "12px 0 0" }}>
              Source: {src.width} × {src.height}
            </p>
          )}
        </section>

        <section className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label htmlFor="key" className="muted" style={{ display: "block", marginBottom: 6, fontSize: "0.9rem" }}>
              Secret key
            </label>
            <input
              id="key"
              type="password"
              value={key}
              placeholder="shared passphrase — choose anything"
              onChange={(e) => setKey(e.target.value)}
            />
          </div>

          <button className="primary" disabled={busy || !src || !key} onClick={() => void doEncode()}>
            {busy ? "Encoding…" : encoded ? "Re-encode" : "Encode image"}
          </button>

          {err && <p style={{ color: "var(--err)", fontSize: "0.9rem", margin: 0 }}>{err}</p>}

          {encoded && (
            <div
              style={{
                position: "relative",
                flex: 1,
                minHeight: 220,
                border: "1px solid var(--border)",
                borderRadius: 10,
                overflow: "hidden",
              }}
            >
              <canvas
                ref={displayCanvasRef}
                style={{ width: "100%", height: "100%", display: "block" }}
              />
              <div style={{ position: "absolute", top: 10, left: 10, fontSize: "0.75rem" }}>
                <span className="muted">encoded preview</span>
              </div>
            </div>
          )}

          <button className="primary" disabled={!encoded} onClick={() => void enterFullscreen()}>
            Host fullscreen for camera
          </button>
        </section>
      </div>

      <p className="muted" style={{ fontSize: "0.8rem", marginTop: 14 }}>
        The receiver needs the same key. Encoded noise looks random; the white frame is the
        receive target.
      </p>
    </main>
  );
}