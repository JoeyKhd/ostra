# Versions and upgrades

**Status:** accepted (plan signed off 2026-11-17). Chosen on 2026-11-17 in grilling round 3.

- **Semantic versioning.** Server and runner images are tagged per release.
- **The server runs its migrations on start.** Migrations add first and drop or rename in a later release (AGENTS.md).
- **Runners can be one version behind.** The server accepts runners up to one minor version older than itself, and tells older runners to update (F-061).

## Consequences

- Teams upgrade on their own schedule (ADR 0001), so the runner protocol changes only in ways one older minor version still understands.
- Each release's notes say what operators must do, if anything.
