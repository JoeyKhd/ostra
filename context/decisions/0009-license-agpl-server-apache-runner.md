# License: AGPL-3.0 for the server, Apache-2.0 for the runner and adapter SDK

**Status:** accepted (plan signed off 2026-11-17). Chosen on 2026-11-17 in grilling round 2.

- **The server and web app** are AGPL-3.0, so nobody can offer a closed hosted copy of ostra. That protects the paid hosted version (ADR 0001).
- **The runner and the adapter SDK** are Apache-2.0, so companies can install runners on their machines and write their own adapters without a legal review.
- **Contributions** come with a DCO sign-off (`Signed-off-by`), not a CLA.

## Considered options

- **Apache-2.0 for everything:** the most adoption, but anyone could sell hosting of the same code.
- **A source-available license (FSL/BUSL):** not open source. Multica shows the friction this causes with self-hosters and contributors (`research/landscape.md`).

## Consequences

- Without a CLA, the AGPL code can't be relicensed later. That only matters for open core, which the maintainer didn't choose.
- Anything only the hosted version needs, such as billing, lives in separate services, not in the AGPL server.
