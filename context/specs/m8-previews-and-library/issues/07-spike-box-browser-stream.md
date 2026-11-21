# 07: Spike: the box's browser, streamed

Status: ready-for-agent
Builder: runner
Blocked by: none
Features: F-141, F-121 (the numbers they rest on)
Packages: `spikes/box-browser-stream/` (new, throwaway), `context/research/spike-box-browser-stream.md` (new)
Spec: `../spec.md`, sections 1 ("On this machine") and 11; ADR 0068 ("If a spike fails"); `research/live-previews.md` §7, recommendation 7

## The question

Can a small box stream its own headless browser to a member's pane at a readable rate, with input coming back, through a relay shaped like core's, on both carriers? And what does it cost?

## What to try

Throwaway code, in `spikes/box-browser-stream/` (`AGENTS.md`):
- **A DevTools client over `--remote-debugging-pipe`,** in plain Node with no dependency, that opens a target and drives `Page.navigate`, `Page.captureScreenshot`, `Page.startScreencast` with `screencastFrameAck` and `maxFramesInFlight`, and `Input.dispatchMouseEvent`, `dispatchKeyEvent` and `insertText`.
- **A relay** standing in for core: one WebSocket from the "sidecar" with binary frames, and a streamed `fetch` response of length-prefixed JPEGs to a page, with input going back as batched `POST`s.
- **The app:** a small Vite and React app of the spike's own, with `server.proxy` to an API on 3001, started in the same network namespace as the browser. (Ticket 03 writes the product's fixture later, from it.)
- **The HTTP carrier:** frames batched up in `POST`s at 2 a second, and input down a 25 s long poll.

## What to measure

Record each, with the machine and the browser's version:
1. **The frame rate and bytes a second** at 1440×900, 1280×800 and 390×844, at JPEG quality 50, 60 and 70, for an idle page, typing in a field, and a page scrolling.
2. **The browser's memory and CPU** in a container capped at 2 vCPU and 4 GB, beside the Vite dev server and the API (on Linux with Docker). Here: on Edge, with the same caps noted as not applied.
3. **Input latency,** from a click in the page to its frame back, through the relay.
4. **A click on the counter** that counts, typing that lands, and pasting text.
5. **The frontend's `/api` call** answered in the streamed page, through Vite's proxy.
6. **The HTTP carrier's** frame rate and input latency.
7. **What a screenshot and a 10-second recording at 10 frames a second weigh,** as PNG and as a JPEG frame reel.

## Passes when

- The view holds at least 8 frames a second at 1280×800 while typing, with input latency under 300 ms at p95 through the relay on this machine, and the box stays inside 2 vCPU and 4 GB with the app running (on Linux).
- The counter, the field and `/api` work in the stream.
- The finding names the defaults ticket 18 should use, and whether ADR 0068's fallback (a screenshot every 2 s) is needed.

**If it fails:** ADR 0068's fallback, as written there. The finding says which bar failed and by how much.

## Done when

- [ ] `context/research/spike-box-browser-stream.md` holds every measurement, cited to its run's log in the spike's folder. The parts that need Linux with Docker are marked as waiting, never as passed.
- [ ] Spec section 11's port line names what tickets 11, 13 and 18 take from the spike.
- [ ] Committed as `✨ spike the box's browser stream`, and the finding as `📝 add the browser stream spike's finding`.

## Comments
