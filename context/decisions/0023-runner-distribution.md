# Shipping the runner: npm and Docker first, signed binaries before launch

**Status:** superseded by ADR 0046 (2026-11-18). ADR 0046 replaces it with one `ostra` CLI, whose name retires `ostra-runner`, and three images (the server, the runner and the box base), and it moves the signed binaries to after v1 (Q80, Q82, F-085). It was accepted with the plan on 2026-11-17, chosen in grilling round 6, and the text below is kept as the historical record.

An unsigned binary downloaded on macOS is blocked by Gatekeeper, and Windows warns about it through SmartScreen. So the runner ships in three forms:

- **Laptops:** an npm package, `npx ostra-runner`, which runs on Node. Members' machines usually have Node already.
- **Servers:** the runner Docker image, with the agents installed (ADR 0012, F-039).
- **Before the public launch (milestone 6):** signed native binaries compiled with Bun (ADR 0008), notarized for macOS and code-signed for Windows (F-085). The maintainer accepted the yearly cost of an Apple Developer Program membership and a Windows code-signing certificate.

## Considered options

- **Unsigned binaries from the start.** Rejected: blocked on macOS and warned about on Windows, which is a bad first impression for a "robust" product.
- **Homebrew, Scoop and winget only.** Rejected for v1: three package channels to maintain before the product exists. They can come later, beside the signed binaries.

## Consequences

- Runner code stays runnable on Node and compilable with Bun. The spikes test both (`build-order.md`, spike 5).
- The runner checks its own version against the server, whatever form it came in (F-061, ADR 0022).
