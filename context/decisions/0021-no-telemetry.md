# No telemetry unless an admin turns it on

**Status:** accepted (plan signed off 2026-11-17). Chosen on 2026-11-17 in grilling round 3. Amended 2026-11-18: it names the one outbound fetch, the model catalog, with its setting and its bundled copy (Q34).

No usage data leaves an install unless its admin turns it on. v1 has none at all. If telemetry is ever added, it's opt-in and documented field by field.

## The one outbound fetch

The server fetches the models.dev catalog (model names, limits, prices and logos) once a day. It's a download of public data and carries no usage data.
- **A setting turns it off.** One setting stops the fetch.
- **A copy is bundled.** Every release bundles a copy of the catalog, so a closed network keeps working with the fetch off.
- **Browsers never call a third party.** The server serves the logos itself.

## Consequences

- What we learn about usage comes from our own team's use and from people telling us. *Changed 2026-11-19: this listed a hosted version first, and none is planned (ADR 0001).*
- Update checks, if any, run only when an admin starts them and send nothing but the version.
- Apart from the calls an organization sets up itself (its tracker, its code host and its model providers), the catalog fetch is the only outbound request the server makes on its own.
