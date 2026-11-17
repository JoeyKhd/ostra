# No telemetry unless an admin turns it on

**Status:** accepted (plan signed off 2026-11-17). Chosen on 2026-11-17 in grilling round 3.

No usage data leaves an install unless its admin turns it on. v1 has none at all. If telemetry is ever added, it's opt-in and documented field by field.

## Consequences

- What we learn about usage comes from the hosted version, from our own team's use, and from people telling us.
- Update checks, if any, run only when an admin starts them and send nothing but the version.
