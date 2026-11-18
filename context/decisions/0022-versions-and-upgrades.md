# Versions and upgrades

**Status:** accepted (plan signed off 2026-11-17). Chosen on 2026-11-17 in grilling round 3. Amended 2026-11-18: a runner may be one minor version behind or ahead of its server, and is pinned to the server's version when it joins (F-061).

- **Semantic versioning.** Server and runner images are tagged per release.
- **The server runs its migrations on start.** Migrations add first and drop or rename in a later release (AGENTS.md).
- **A runner may be one minor version behind or ahead.** The server accepts runners within one minor version either way, and tells an older runner to update (F-061). A runner outside that range is refused with a clear message. A runner is pinned to its server's version when it joins. The usual case is a runner ahead, because a freshly installed runner is usually newer than its server (`research/runner-transport.md`, risk 1).

## Consequences

- Installs upgrade on their own schedule (ADR 0001), so the runner protocol changes only in ways that one minor version, older or newer, still understands.
- Each release's notes say what operators must do, if anything.
