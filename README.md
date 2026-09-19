# Visual Image Transfer

Send a picture from one device's screen to another device's camera — no network,
no app-to-app pairing. The sender encodes the image into deterministic,
keyed visual noise and hosts it fullscreen; the receiver watches for a white
frame through its camera, reads the embedded metadata block, warps the noise
back to a canonical grid, inverse-scrambles it, and verifies a set of CRCs
before showing the recovered image.

Everything runs client-side (React + Vite + TypeScript). The encode/decode
pipeline lives in `src/lib` and is fully unit-tested against a synthetic
perspective-warped camera (`tests/pipeline.test.ts`).

## Why it looks like noise

Without the secret key there is no way to reconstruct the image — every stage
(per-channel permutation, additive masks, coordinate transform, XOR noise
canvas, block shuffle, pixel shuffle) is keyed and reversible. The displayed
frame is indistinguishable from static; even the metadata block is keyed-noise
redundancy over the payload. Confirm with each other by sight, not by a shared
link.

## The on-screen format

The fullscreen host renders, on a black background, a white square frame
(detection anchor). Inside, filling most of the frame:

- a large central noise region (the padded encoded canvas stretched in),
- three QR-style finder markers at the top-left, top-right and bottom-left
  corners of the noise region plus two small alignment markers at
  bottom-center / right-center (these pin the edges near the metadata block;
  the receiver uses them to re-register the frame to sub-pixel accuracy),
- a 32×32 metadata block in the bottom-right margin (padded dims, content
  size, CRC32 + 4× CRC16 group digests, 3× redundancy).

The receiver detects the white frame (threshold + connected components +
convex hull + sub-pixel edge refinement), reads the metadata cells through the
frame homography, registers the data rect, inverse-scrambles using the shared
key, and only reports success when the digests verify.

## Getting started

```sh
npm install
npm run dev        # http://localhost:5173
```

**Camera access requires HTTPS** (or `localhost`). On your phone, either visit
deployed GitHub Pages (`https://<you>.github.io/<repo>/`) or tunnel
`npm run dev` with an HTTPS proxy.

## Scripts

| Command            | What it does                            |
| ------------------ | --------------------------------------- |
| `npm run dev`      | Vite dev server                         |
| `npm run test`     | Vitest (crypto determinism + e2e decode)|
| `npm run typecheck`| `tsc -b --noEmit`                       |
| `npm run build`    | Type-check + production build           |
| `npm run preview`  | Serve the production build              |

## How to use

1. **Sender**: open the app, drop/paste an image, choose a secret key,
   *Encode*, then *Host fullscreen for camera*. Tell the receiver the key.
2. **Receiver**: open the app on the second device, enter the same key, start
   the camera, and point it squarely at the sender's screen with all four
   corners of the white frame in view. Keep it steady; a box overlay shows the
   detected frame. The decoded image pops up with a match percentage.

## Architecture

```
src/lib/rng.ts        deterministic SHA-256 + xorshift128+ key scheduling
src/lib/encode.ts     6-stage keyed scramble + padding + digests
src/lib/decode.ts     exact inverse of every stage + digest verification
src/lib/compose.ts    display geometry (CANONICAL 1200 px shared space)
src/lib/detect.ts     white-frame detection: threshold→hull→refine quad
src/lib/warp.ts       homography + cell sampling + bilinear registration
src/lib/meta.ts       192-bit keyed metadata payload (4 group CRCs ×3 copies)
src/lib/receiver.ts   per-frame pipeline: detect → read meta → decode
src/lib/workers/*     UI-thread offload (encode + decode workers)
src/pages/*           Sender / Receiver UI
```

The digest scheme tolerates mild camera noise: content is quantized to its top
4 bits before CRC comparison, and 4 vertical group CRCs fail soft (min 3/4
match) so motion blur or relighting degrades gracefully instead of hard
failing.

## Deployment (GitHub Pages)

Push to `main`; the included workflow
(`.github/workflows/deploy.yml`) builds and publishes to `gh-pages`.
`vite.config.ts` already uses a relative `base: "./"` so the app works under
`/repo/`. Because camera access needs HTTPS, GitHub Pages is a convenient
always-on deployed demo.