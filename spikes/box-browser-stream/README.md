# Spike: `box-browser-stream`

Throwaway code for milestone 8's ticket 07 (`context/specs/m8-previews-and-library/issues/07-spike-box-browser-stream.md`). Its finding is `context/research/spike-box-browser-stream.md`. Product code never imports this folder: tickets 11, 13 and 18 copy what they need, with a provenance line.

## The question

Can a small box stream its own headless browser to a member's pane at a readable rate, with input coming back, through a relay shaped like core's, on both carriers? And what does it cost?

## The shape

```
member's browser (a second headless Edge)                web hop (src/relay/web.ts, :8791)
  viewer page: canvas, length-prefixed JPEGs  ──GET /api/previews/v1/stream──▶  relays core's stream
  input as batched POSTs, one in flight       ──POST /api/previews/v1/input──▶  posts on to core
                                                            │
                                         core (src/relay/core.ts, :8790)
                                           GET /panel/v1/previews/v1/stream, POST …/input
                                           acks a frame once every stream took it (write buffer drained)
                                                            ▲
             WebSocket carrier: wss /runner/v1/preview?view=v1, binary: 1-byte type + payload
             HTTP carrier: POST /runner/v1/preview/frames (multipart), GET …/down (25 s long poll)
                                                            │
sidecar (src/sidecar/main.ts, control :8792) ── DevTools over --remote-debugging-pipe ── the box's Edge
  one shared page on the app; Page.startScreencast with maxFramesInFlight and acks; Input.dispatch*
                                                            │
the app: Vite + React (app/, :5173) with server.proxy /api ──▶ the API (src/api/main.ts, :3001)
```

- **`src/cdp/pipe.ts`** is the DevTools client: the browser reads NUL-terminated JSON on its fd 3 and writes on fd 4, so no port is opened. `src/cdp/page.ts` attaches a page with a flat session.
- **`src/sidecar/screencast.ts`** caps the frame rate two ways: `ack` holds the browser's ack until 1/cap s after the last one (with `sendLastFrame`, so the last change still arrives); `drop` acks at once and forwards at most cap a second, keeping the newest frame for the next slot.
- **`src/sidecar/input.ts`** maps the member's mouse, wheel, keys and pasted text onto `Input.dispatchMouseEvent`, `dispatchKeyEvent` and `insertText`.
- **`src/wire.ts`** holds the preview connection's stream-mode format and the member's stream as Zod schemas (strict objects: ostra owns the format).
- **`src/viewer/viewer.ts`** is the member's pane, served with its types stripped. The app shows two 4-bit counters as squares in its corner (presses on its counter, keydowns), and the viewer reads them from each decoded frame, so every click and key is timed from the member's input event to the frame that shows it, even while typing without pause.
- **`src/harness/`** starts everything, drives the member's browser over its own pipe, samples CPU and memory of each process tree once a second (`sampler.ps1`), and pins the box's processes to two logical processors for the cap's approximation (`affinity.ps1`).

## How to run it

```sh
cd spikes/box-browser-stream
pnpm install
pnpm typecheck && pnpm lint
pnpm spike          # about 15 minutes; results/<run>/run.log and results.json
pnpm spike:quick    # 2 s windows, one quality, for development
node src/harness/smoke.ts   # the pipe and what sendLastFrame does
```

It uses the machine's Chrome, Chromium or Edge (`SPIKE_BROWSER` names another), and ports 3001, 5173 and 8790 to 8792. Every child, both browsers and their temporary profiles end with the run.

## What it can't do here

The ticket's box is a container capped at 2 vCPU and 4 GB, on Linux with Docker. This machine is Windows with neither, so the browser is Edge, the caps aren't applied (the pinned run approximates the CPU cap only), and the init's bridge between the browser and the sidecar isn't in the path. Those parts wait for the `live-docker` job.
