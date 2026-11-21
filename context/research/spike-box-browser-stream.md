# Research: Spike `box-browser-stream`: can a small box stream its own headless browser to a member's pane?

**Status:** Research, 2026-11-21. Milestone 8's ticket 07. Feeds ADR 0068 ("The browser view", "Screenshots and recordings", "The HTTP fallback carrier", "If a spike fails"), F-141 and F-121, and tickets 11, 13 and 18.

**Method:**
- One run of `pnpm spike` in `spikes/box-browser-stream/`, on 2026-11-21 from 02:02 to 02:16 UTC. It wrote `run.log` and `results.json` to `SPIKE/results/2026-11-21T02-02-55/` (below, `RUN` and `JSON`). A figure is cited by the label of its line in `RUN`, and every figure is also in `JSON` under the same name. Earlier `--quick` runs were for development and aren't cited.
- **The machine:** Windows 11 Pro 10.0.26200, an Intel Core i9-13900K (8 performance cores with two threads each and 16 efficiency cores, 32 logical processors), 32 GB, Node 24.14.0 (`RUN`, `machine`). Other programs were running: the machine's total CPU was 16% busy just before the run (PowerShell's `\Processor(_Total)\% Processor Time`, three 2 s samples). Treat every number as measured on a shared machine.
- **The browsers:** the box's browser and the member's browser are both headless Microsoft Edge 157.0.4341.60 (`Edg/157.0.4341.60`, `RUN`, `machine`), the one browser every Windows machine has (spec, section 1, "On this machine"). The box's runs with a fresh profile and software rendering (`--disable-gpu`), since a container has no GPU (`SPIKE/src/cdp/pipe.ts:71-88`).
- **CPU and memory** come from `SPIKE/src/harness/sampler.ps1`, which reads each process tree's CPU time, private bytes and working set about every 1.4 s (`JSON`, `samplerTickMs`: 1,414). CPU is given in vCPUs: CPU seconds per second over a window bracketed by the samples before and after it (`SPIKE/src/harness/sampler.ts:46-78`), so 2.0 is a whole small box. Private bytes are the closest to what a container's memory limit counts. Working sets double-count shared pages.
- **This CPU is hybrid.** Windows may run an unpinned process on an efficiency core, which spends more CPU time on the same work than a performance core. The pinned runs (section 3.4) put the box's processes on the two threads of one performance core, which is how a cloud "2 vCPU" box is usually made.
- **Input latency** is timed in the member's page from the input event to the decoded frame that shows it (section 3.3).
- The DevTools Protocol's parameters are quoted from its published JSON ([`browser_protocol.json`](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json), read 2026-11-21).

**Source links.** `SPIKE` is `spikes/box-browser-stream`. A cite such as `SPIKE/src/sidecar/screencast.ts:97-113` is a file and its lines.

---

## Facts

| Thing | Version | Where |
|---|---|---|
| Node | 24.14.0 | `RUN`, `machine` |
| The box's and the member's browser | Microsoft Edge 157.0.4341.60, headless | `RUN`, `machine` |
| `ws` | 8.23.0, as in `apps/runner` and `apps/core` | `SPIKE/package.json` |
| `zod` | 4.6.7, as in the product | `SPIKE/package.json` |
| Vite, `@vitejs/plugin-react`, React | 8.3.8, 6.3.0, 19.3.1 (the app only) | `SPIKE/package.json` |
| The DevTools client | the spike's own, no dependency | `SPIKE/src/cdp/pipe.ts` |

---

## 1. The question, and the answer

**Question** (the ticket): can a small box stream its own headless browser to a member's pane at a readable rate, with input coming back, through a relay shaped like core's, on both carriers? And what does it cost?

**Answer: yes on this machine, with room to spare.** ADR 0068's fallback, a screenshot every 2 s, isn't needed.
- **The rate.** The stream sends a frame when the page changes, so it follows the page:
  - 0 frames a second on an idle page;
  - about one a keystroke while typing;
  - 32 a second while scrolling at a trackpad's pace;
  - 60 a second on a page that animates without pause.

  ADR 0068's working cap of 15 frames a second at 1440×900, quality 60, held in every case it was meant to.
- **The latency.** Through core and the web hop, a click came back in 33 ms at p50 and 56 ms at p95, at 1280×800 and 15 frames a second. A key typed at 15 a second came back in 22 ms at p50 and 53 ms at p95.
- **The cost.**
  - The box's browser used 0.5 to 0.8 vCPU while streaming at the working defaults, and 0.33 to 0.54 pinned to one performance core.
  - It held 280 to 460 MB of private memory, beside Vite's 151 MB and the API's 39 MB.
  - An idle page or no open view cost it almost nothing.
  - The real cost is bandwidth through core: about 1.1 MB/s, 9 Mbit/s, for each member watching a page that keeps changing at the defaults.
- **Input works:** the counter counts, typing lands, a paste lands with its accents, and the frontend's `/api` call answers through Vite's proxy, all through the stream.
- **The HTTP carrier** gives 2 frames a second, as ADR 0068 says. A lone click comes back as quickly as on the WebSocket, but typing lags: 310 ms at p50 and 560 ms at p95.
- **What waits for Linux with Docker:** the 2 vCPU and 4 GB container caps, Debian's Chromium in place of Edge, and the init's bridge between the browser and the sidecar (section 6).

---

## 2. Against the ticket's bar

| Bar (ticket 07, "Passes when") | Result | Evidence |
|---|---|---|
| At least 8 frames a second at 1280×800 while typing | **Passes here.** 15.0 fps typing at 15 keys a second, uncapped and capped at 15; 15.0 fps at 25 keys a second capped at 15; 8.2 fps on the fallback's cap of 8 | `RUN`: `1280x800 q60 typing`, `1280x800 q60 cap15 (ack) typing`, `1280x800 q60 cap15 typing at 25 keys/s`, `fallback 1280x800 q50 cap8 (ack) typing` |
| Input latency under 300 ms at p95 through the relay, on this machine | **Passes here.** Clicks 55 to 62 ms at p95; single keys 53 to 96 ms; keys while typing at 15 a second 53 ms (1280×800, cap 15), 94 ms (1440×900, cap 15) and 157 ms (the fallback's cap of 8) | `RUN`, section 3, every `latency` line |
| The box stays inside 2 vCPU and 4 GB with the app running (on Linux) | **Waiting** for Linux with Docker. Here, uncapped: the box's browser peaked at 1.08 vCPU and 456 MB private, Vite at 153 MB and the API at 39 MB. Pinned to two logical processors, the same streams ran at the same rates on 0.31 to 0.54 vCPU | section 3.4; `RUN`, `pinned …` |
| The counter, the field and `/api` work in the stream | **Passes.** 5 clicks show "Count: 5", "hello ostra" lands, a paste of " pasted: été ✓ 2026" lands after it, and the page shows "api: ok, hello from the API on 3001" | `RUN`, `functional`; the member's view, `SPIKE/results/2026-11-21T02-02-55/member-view-1280x800.png` |
| The finding names ticket 18's defaults, and whether the fallback is needed | Section 5; the fallback isn't needed | — |

---

## 3. The measurements

### 3.1 Frame rate and bytes, uncapped

The screencast ran with `maxFramesInFlight` 3 and each frame acked once core had written it to the member's stream (`SPIKE/src/relay/core.ts:65-84`, `:201-206`), with no cap. In each 6 s window the member's browser either did nothing (idle), typed at 15 keys a second, sent 60 wheel events a second of 40 px each (a trackpad's pace, `SPIKE/src/harness/run.ts:227`), or watched a CSS spinner (animating).

| Size, quality | Idle | Typing | Scrolling | Animating |
|---|---|---|---|---|
| 1440×900, q50 | 0 fps, 0 KB/s | 15 fps, 1,001 KB/s (66.7 KB a frame) | 32.1 fps, 2,299 KB/s (71.7) | — |
| 1440×900, q60 | 0 fps, 0 KB/s | 15 fps, 1,106 KB/s (73.7) | 32.1 fps, 2,567 KB/s (80.0) | 60 fps, 4,396 KB/s (73.3) |
| 1440×900, q70 | 0 fps, 0 KB/s | 15 fps, 1,264 KB/s (84.3) | 32.0 fps, 2,967 KB/s (92.8) | — |
| 1280×800, q50 | 0 fps, 0 KB/s | 15 fps, 840 KB/s (56.0) | 32.1 fps, 1,977 KB/s (61.7) | — |
| 1280×800, q60 | 0 fps, 0 KB/s | 15 fps, 931 KB/s (62.1) | 32.1 fps, 2,205 KB/s (68.7) | 60.2 fps, 3,693 KB/s (61.4) |
| 1280×800, q70 | 0 fps, 0 KB/s | 15 fps, 1,061 KB/s (70.7) | 32.1 fps, 2,559 KB/s (79.7) | — |
| 390×844 phone, q50 | 0 fps, 0 KB/s | 15 fps, 460 KB/s (30.7) | 32.1 fps, 1,084 KB/s (33.7) | — |
| 390×844 phone, q60 | 0 fps, 0 KB/s | 15.2 fps, 520 KB/s (34.3) | 32.1 fps, 1,222 KB/s (38.0) | 60 fps, 2,048 KB/s (34.1) |
| 390×844 phone, q70 | 0 fps, 0 KB/s | 15.2 fps, 603 KB/s (39.7) | 32.1 fps, 1,428 KB/s (44.5) | — |

The member's browser received every frame the box's browser produced in every window (`RUN`, "member … fps" against "browser … fps"). The rates are the member's. What the table shows:
- **An idle page sends nothing,** and the box's browser used 0.004 to 0.053 vCPU with a view open on it.
- **Quality moves the size by about 10% a step.** From q60, q50 saves 9 to 10% of the bytes and q70 costs 14 to 16% more (the typing column at each size).
- **The size of the view matters more:** a phone frame is about half a 1280×800 one.
- **The pipeline can carry 60 frames a second at 1440×900,** the browser's own frame rate, so the cap below is a choice, not a limit.

The box's browser used:
- 0.50 to 0.70 vCPU typing or scrolling at 1280×800 and 1440×900;
- 1.08 vCPU animating at 60 fps at 1440×900;
- 0.20 to 0.42 vCPU at the phone's size.

The sidecar used at most 0.047 vCPU, core 0.049 and the web hop less (`JSON`, `grid[].use`).

### 3.2 Capped: ADR 0068's working values, and two ways to cap

`SPIKE/src/sidecar/screencast.ts` caps the rate two ways:
- **Holding the ack** (`ack`, lines 104-113): the ack for a frame waits until 1/cap s after the previous one, with `maxFramesInFlight` 1, so the browser makes only that many frames.
- **Dropping** (`drop`, lines 97-103): every frame is acked at once, and the sidecar forwards at most cap a second, keeping the newest for the next slot.

| Run (6 s) | Member fps | KB/s | Box browser vCPU |
|---|---|---|---|
| 1440×900 q60 cap 15, hold the ack: typing | 15.0 | 1,106 | 0.658 |
| … scrolling | 15.1 | 1,211 | 0.619 |
| … animating | 15.0 | 1,099 | 0.779 |
| 1440×900 q60 cap 15, drop: typing | 14.2 | 1,045 | 0.667 |
| … scrolling (the browser made 32.1 fps) | 14.8 | 1,183 | 0.663 |
| … animating (the browser made 60 fps) | 14.8 | 1,087 | 1.080 |
| 1280×800 q60 cap 15, hold: typing | 15.0 | 931 | 0.477 |
| … scrolling | 15.3 | 1,052 | 0.527 |
| … animating | 15.0 | 921 | 0.636 |
| 1280×800 q50 cap 8 (the fallback), hold: typing | 8.2 | 457 | 0.518 |
| … scrolling | 8.1 | 501 | 0.474 |
| … animating | 8.0 | 440 | 0.596 |
| 1280×800 q60 cap 15, typing at 8 keys a second | 8.0 | 487 | 0.340 |
| 1280×800 q60 cap 15, typing at 25 keys a second | 15.0 | 954 | 0.761 |

Source: `RUN`, the lines of the same names.
- **Hold the ack, don't drop.** On a page that changes every frame, dropping cost 1.08 vCPU against 0.78, because the browser still painted and encoded 60 frames a second and the sidecar threw 45 away.
- **Holding the ack needs `sendLastFrame`.** The protocol says: "By default, after screencastFrameAck arrives, the next produced frame is sent. Passing this flag enables storing the last produced frame in memory, which is immediately sent upon screencastFrameAck" ([`Page.startScreencast`](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json)). `SPIKE/src/harness/smoke.ts` made 10 changes in 200 ms with acks held to 2 a second, then left the page alone:
  - without the flag, no frame came after the burst, so the last change never reached the member;
  - with it, the last one arrived 298 to 312 ms after the burst (two runs of `node src/harness/smoke.ts`, the second after the run, with `sendLastFrame=true: frames after the burst 3 at -192,-177,312 ms`).

  Edge 157 honours the flag. Every capped run used it, and every input in sections 3.3 and 3.5 was seen.

### 3.3 Input latency

The app draws two 4-bit counters as squares in its corner: presses on its counter button and keydowns, each mod 16 (`SPIKE/app/src/app.tsx`). The member's page counts what it sent, reads the squares from every decoded frame, and gives each input the time from its DOM event to the first drawn frame that shows it (`SPIKE/src/viewer/viewer.ts:24-48`, `:125-127`). So keys can be timed while typing without a pause, and the decode and the draw are included. Every input sent was seen: no "unmatched" in any run (`JSON`, `latency[].unmatched`).

The path is the member's page → the web hop → core → the sidecar → the page in the box, and back by the same hops (`SPIKE/README.md`, "The shape").

| Run | What | n | p50 | p95 | max |
|---|---|---|---|---|---|
| 1280×800 q60, uncapped | clicks 450 ms apart | 40 | 52 ms | 55 ms | 55 ms |
| | keys 300 ms apart | 40 | 35 | 89 | 91 |
| | keys while typing at 8 a second | 48 | 35 | 91 | 96 |
| | keys while typing at 15 a second | 90 | 35 | 93 | 95 |
| 1280×800 q60, cap 15 | clicks | 40 | 33 | 56 | 59 |
| | keys | 40 | 23 | 53 | 57 |
| | typing at 8 a second | 48 | 20 | 52 | 54 |
| | typing at 15 a second | 90 | 22 | 53 | 92 |
| 1440×900 q60, cap 15 (the working defaults) | clicks | 40 | 32 | 60 | 61 |
| | keys | 40 | 27 | 53 | 59 |
| | typing at 8 a second | 48 | 35 | 94 | 100 |
| | typing at 15 a second | 90 | 40 | 94 | 101 |
| 1280×800 q50, cap 8 (the fallback) | clicks | 40 | 54 | 57 | 58 |
| | keys | 40 | 60 | 96 | 107 |
| | typing at 8 a second | 48 | 36 | 97 | 98 |
| | typing at 15 a second | 90 | 99 | 157 | 213 |
| 1280×800 q60, cap 15, core only (no web hop) | clicks | 40 | 54 | 62 | 78 |

Source: `RUN`, section "3. input latency".
- **The hops add little.** The same clicks through core alone took longer here than through both hops, which says the run-to-run spread (tens of milliseconds on a shared machine) is larger than the web hop's cost.
- **A cap of 8 shows when typing fast:** keys wait up to 125 ms for the next frame, and p95 doubles to 157 ms. It still meets the bar.
- **The member's page decoded and drew a frame in 3.9 to 5.2 ms** at 1280×800 and 1440×900, and 1.1 to 2.1 ms at the phone's size (`JSON`, `decodeMsAvg`).

### 3.4 CPU and memory, and two logical processors

**Memory** (`RUN`, `no view` and the grid's lines):

| Process | No view open | Peak while streaming |
|---|---|---|
| The box's browser (10 to 18 processes) | 289 MB private, 617 MB working set | 456 MB private, 943 MB working set, in the run's first window. It then held 280 to 317 MB private |
| Vite (with esbuild) | 151 MB private | 153 MB |
| The API | 39 MB private | 39 MB |

So the app and its browser hold about 0.5 to 0.65 GB of a small box's 4 GB, before the agent and the setup's own processes.

**Pinned to two logical processors** (affinity `0xC`: the two threads of one performance core, set on the browser's, Vite's and the API's process trees, `SPIKE/src/harness/affinity.ps1`, `SPIKE/src/harness/run.ts:480-494`). This caps CPU only, with no container and no memory limit:

| Run (pinned) | Member fps | Box browser vCPU | Latency |
|---|---|---|---|
| 1280×800 q60 uncapped, typing | 15.0 | 0.440 | — |
| 1280×800 q60 uncapped, scrolling | 32.1 | 0.341 | — |
| 1280×800 q60 cap 15, typing | 15.0 | 0.344 | keys while typing at 15 a second: p50 26 ms, p95 59 ms |
| 1280×800 q60 cap 15, scrolling | 15.3 | 0.332 | clicks: p50 40 ms, p95 47 ms |
| 1280×800 q50 cap 8, typing | 8.2 | 0.310 | typing at 15 a second: p95 157 ms |
| 1440×900 q60 cap 15, typing | 15.0 | 0.370 | typing at 15 a second: p50 31 ms, p95 65 ms |
| 1440×900 q60 cap 15, scrolling | 15.1 | 0.367 | — |
| 1440×900 q60 cap 15, animating | 15.0 | 0.535 | — |

Source: `RUN`, the `pinned …` lines. On two threads of a performance core, the browser kept every rate and every latency inside the bar, and never used more than 0.54 of its 2 vCPUs. The vCPU figures are lower than unpinned for the same work because none of it ran on an efficiency core.

### 3.5 The HTTP carrier

`SPIKE/src/sidecar/main.ts:95-105` posts each frame as it comes, in a multipart `POST /runner/v1/preview/frames`, with the ack held to 2 frames a second. Input comes down `GET /runner/v1/preview/down`, held up to 25 s (`SPIKE/src/relay/core.ts:154-169`).

| Run, 1280×800 q60, cap 2 | Result |
|---|---|
| typing | 2.0 fps, 124 KB/s |
| scrolling | 2.0 fps, 137 KB/s |
| clicks 1.3 s apart | p50 68 ms, p95 70 ms, max 522 ms (n 20) |
| keys 0.9 s apart | p50 245 ms, p95 543 ms (n 20) |
| keys while typing at 8 a second | p50 310 ms, p95 560 ms (n 48) |
| 3 clicks on the counter | counted 20 → 23 |

Source: `RUN`, `http …`. A lone input is answered as fast as on the WebSocket when the 500 ms slot is free, because the long poll returns at once and the held ack lets the next frame through. While typing, each key waits for the next slot. That's a usable view, not a comfortable one for typing, as ADR 0068 already expects (2 frames a second at most on the HTTP carrier).

### 3.6 What a screenshot and a recording weigh

Each is taken in a page of its own, not the shared page (`SPIKE/src/sidecar/main.ts:193-207`, `:220-288`), at 1440×900 unless named:

| Item | Weight | Notes |
|---|---|---|
| A PNG screenshot, 1440×900 | 153,197 bytes (150 KB) | captured in 80 ms; 678 ms from opening the page to the image |
| A PNG screenshot, 390×844 phone | 63,254 bytes (62 KB) | 52 ms; 603 ms |
| A 10 s frame reel, 10 fps, JPEG q60: 3 clicks, then typing | 41 frames, 3,028,387 bytes (2.9 MiB) with its index | the screencast sends a frame only when the page changes |
| The same at q50 | 39 frames, 2,604,687 bytes (2.5 MiB) | |
| 10 s, 10 fps, JPEG q60, scrolling without a pause | 102 frames, 8,374,033 bytes (8.0 MiB) | the worst case: every frame changes |
| The same two as PNG frames | 10,980,347 bytes (10.5 MiB); 12,708,817 bytes (12.1 MiB) | |

Source: `RUN`, `screenshots`, `reelJpeg60Interact`, `reelJpeg50Interact`, `reelJpeg60Scroll`, `reelPngInteract`, `reelPngScroll`; `JSON`, `weights`.
- **ADR 0068's limits hold for JPEG reels.** A 30 s recording at 10 fps of a page that changes in every frame would be about 24 MiB at q60, inside the 32 MiB cap. As PNG frames it would be about 36 MiB.
- **A screenshot is far inside 8 MiB.**

---

## 4. Findings beyond the numbers

- **The pipe works on Windows from plain Node.** `spawn` with `stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"]` gives the browser its fd 3 and 4. Messages are NUL-terminated JSON. No port is opened (`SPIKE/src/cdp/pipe.ts:95`, `:140-153`).
- **One frame costs the sidecar a base64 decode,** because DevTools sends frames as base64 in JSON. That stayed under 0.05 vCPU (section 3.1). On `docker` the frames also cross the init's bridge, which isn't measured here.
- **Keys need a Windows virtual-key code** for keys that type nothing. `KeyboardEvent.keyCode` is deprecated, so the member's page derives it from `code` (`SPIKE/src/viewer/viewer.ts:281-289`), and the sidecar sends `rawKeyDown` for them (`SPIKE/src/sidecar/input.ts:31-47`).
- **The back-pressure engaged.** At 32 and 60 frames a second, core's write to the web hop's response returned `false` often enough that Node warned of more than 10 `close` listeners on one response (`SPIKE/results/2026-11-21T02-02-55/core.log`, `MaxListenersExceededWarning`). That's the ack waiting on `drain`, as designed. The warning itself was a leak: the `close` listener stayed when `drain` fired first. After the run, each now removes the other (`SPIKE/src/relay/core.ts`, `relayFrame`).
- **A paste is `Input.insertText` with the text,** from the member's `paste` event (`SPIKE/src/sidecar/input.ts:49-50`). Accents and symbols arrived intact (section 2). Files and the clipboard itself don't cross, as ADR 0068 says.
- **The profile can outlive the browser.** The measured run left its three temporary profiles in `SPIKE/.profiles/`:
  - one was the sidecar killed by the harness, not closed;
  - two were browsers whose helper processes still held files when the removal ran.

  After the run, the spike turns off the crash reporter (`--disable-breakpad`, `--disable-crash-reporter`), retries the removal for up to 15 s, and closes the sidecar before killing it (`SPIKE/src/cdp/pipe.ts`, `SPIKE/src/harness/run.ts`). A `--quick` run then left none. Ticket 11's "no cookie or file of the browser left after the box ends" needs the same care.

---

## 5. What tickets 11, 13 and 18 take

**Ticket 11 (the box's browser):**
- the pipe client, `SPIKE/src/cdp/pipe.ts` and `page.ts`;
- the flags, `boxBrowserArgs`, with the crash reporter off;
- closing with `Browser.close`, then killing the tree, then removing the profile with retries.

**Ticket 13 (screenshots and recordings):**
- a page of its own per screenshot or recording;
- `Page.captureScreenshot` as PNG;
- recordings as the screencast at 10 fps by held acks with `sendLastFrame`, kept as JPEG q60 frames in one reel. JPEG reels fit ADR 0068's 32 MiB for 30 s; PNG ones don't (section 3.6).
- The spike waits for its own app's `/api` answer before a screenshot. The product's "network goes quiet" wait is the ticket's own.

**Ticket 18 (the browser view): the defaults.**

| Setting | Value |
|---|---|
| `Page.startScreencast` | `format: "jpeg"`, `quality: 60`, `maxWidth` and `maxHeight` the view's size (at most 1440×900), `everyNthFrame: 1`, `maxFramesInFlight: 1`, `sendLastFrame: true` |
| The cap | 15 frames a second on the WebSocket carrier, 2 on the HTTP carrier, by holding each frame's ack until 1/cap s after the last one; never by dropping frames |
| The ack | sent to the browser once core has written the frame to every open stream (core's `ack` message), so a slow member slows the browser down rather than queueing |
| The sizes | desktop 1440×900, phone 390×844 with `mobile: true` and touch emulation (`SPIKE/src/cdp/page.ts:38-48`) |
| The member's pane | one `fetch` stream of length-prefixed records; decode the newest with `createImageBitmap`, skip older ones while a decode runs; input in `POST`s with one in flight, mouse moves coalesced (`SPIKE/src/viewer/viewer.ts:130-139`, `:193-216`) |
| Input | mouse and wheel as `Input.dispatchMouseEvent`, keys as `keyDown` with text or `rawKeyDown` with a virtual-key code, a paste as `insertText`, applied in order (`SPIKE/src/sidecar/input.ts`) |
| The HTTP carrier | each frame posted as it comes (multipart), at most 2 a second; input down the 25 s long poll |

**ADR 0068's fallback is not needed.**
- The working values held every bar here, and 1280×800 at cap 8 and q50 held them too.
- The fallback's lowered defaults roughly halve the bandwidth: 440 to 500 KB/s against 920 to 1,210 KB/s (section 3.2). They stay a setting to reach for if core's egress, not the box, turns out to be the limit.

---

## 6. What isn't measured, and waits

- **Waiting for Linux with Docker** (the `live-docker` job of `proof.yml`, which hasn't run):
  - the browser and the app inside a container capped at 2 vCPU and 4 GB;
  - Debian's `chromium` in place of Edge;
  - the pipe crossing the init's bridge to the sidecar;
  - the box's network keeping public fonts out of the frames.

  Section 3.4's pinned runs approximate the CPU cap only.
- **Not tried at all:**
  - a slow or lossy member link (the ack path should lower the rate on its own, but no throttled link was run);
  - several members watching one page;
  - a real app heavier than the spike's.

---

## 7. What this means for ostra

- The browser view is cheap on the box. The browser idles at almost nothing, and streams at the working defaults on well under one of a small box's two vCPUs. With Vite and an API beside it, the whole app holds about half a gigabyte.
- The cost to plan for is core's bandwidth: about 1 MB/s per watching member while the page changes, and nothing while it doesn't.
- ADR 0068's working values stand: 15 frames a second, quality 60, at most 1440×900, and 2 frames a second on the HTTP carrier.
- The cap works by holding the screencast's acks with `sendLastFrame` on. Without the flag, the last change before a pause is lost.
