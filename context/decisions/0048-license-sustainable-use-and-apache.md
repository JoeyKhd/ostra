# License: the Sustainable Use License for the server, Apache-2.0 for the runner and SDK

**Status:** accepted (2026-11-18, the maintainer's choice). Supersedes ADR 0009. The maintainer: "i want it to be opensource but you cant sell or distribute this software in any way".

The code is public. Nobody but the maintainer may sell the server and the panel, or distribute them except free of charge for non-commercial purposes. No OSI-approved license can say that, so ostra is **source-available**, not open source. The runner, protocol, adapter SDK, adapters and tooling stay Apache-2.0 on purpose.

- **The server and the web panel** move from AGPL-3.0 to n8n's **Sustainable Use License, version 1.0**. That covers `apps/web`, `apps/core` and every package that isn't Apache-2.0: `db`, `domain`, `api`, `jobs` and `task-view`.
  - A company may use it for its own internal business purposes. Anyone may use it for non-commercial or personal use.
  - Nobody may sell it. Nobody may offer it to others as a paid service.
  - Sharing is allowed only free of charge and for non-commercial purposes.
- **The runner, the protocol, the adapter SDK, the adapters and the tooling stay Apache-2.0:** `apps/runner`, `packages/protocol`, `packages/adapter-sdk`, `packages/adapters/*` and `packages/tooling`. Companies can run runners and write adapters without a legal review. That half of ADR 0009 stands.
- **The word for ostra is "source-available".** The code is public, and anyone can self-host it for their own team. "Open source" is an OSI term that ostra no longer meets, so it describes ostra nowhere in the present tense.
- **Contributions need a CLA.** The DCO-only rule of ADR 0009 is replaced. With a CLA, the maintainer can still offer the hosted version and commercial licenses with contributed code in them. The CLA is chosen before the first outside contribution is accepted. Until then the project takes no outside code, as the README already says.
- **The paid hosted version stays the maintainer's alone.** The license of the server and the panel is what protects it (ADR 0001).
- **The licensor and copyright holder, for now:** "JoeyKhd (https://github.com/JoeyKhd), the maintainer of ostra". The maintainer may later replace this with a legal name or a company.
- **The earlier AGPL copies stay AGPL.** The plan and the repo skeleton were pushed under AGPL-3.0 earlier on 2026-11-18. Anyone who already has those copies keeps them under AGPL-3.0. Every version from this change on is under the new terms.

## Considered options

- **AGPL-3.0, as before (ADR 0009).** Rejected: it is real open source, and that is the problem. It lets anyone sell ostra, and sell hosting of it, as long as they publish their changes.
- **The Functional Source License (FSL-1.1).** Rejected: it allows use for anything except a competing product, so a company can distribute ostra freely if the copy doesn't compete. Each release also turns into Apache-2.0 after two years, which gives the code away on a timer.
- **The Elastic License 2.0 and PolyForm Shield.** Rejected: they forbid competing services, but they allow other kinds of distribution. That is the same gap as FSL.
- **PolyForm Noncommercial.** Rejected: it forbids even a company's own internal use, and that is ostra's main audience.
- **Apache-2.0 for everything.** Rejected in ADR 0009, and still rejected: anyone could sell hosting of the same code.

## Consequences

- **ostra is source-available, not open source.** The README, the docs, the site and the brand files say "source-available" and never "open source" for ostra. ADR 0009 rejected a source-available license over the friction that Multica shows with self-hosters and contributors (`research/landscape.md`). The maintainer accepts that cost.
- **The CLA replaces the DCO.** The maintainer picks the CLA and the way contributors sign it before the first outside contribution is accepted. The README keeps saying that no outside code is taken until then.
- **Companies can self-host ostra for their own team for free.** Nobody else may sell the server or the panel, offer them as a paid service, or hand them on except free of charge for non-commercial purposes.
- **The license check in CI guards a different line.** The rule of ADR 0045 now says that an Apache-2.0 package must not depend on a Sustainable Use package, directly or through another. `protocol`, `adapter-sdk`, `adapters/*` and `runner` still never import `db`, `domain` or `api`. The Sustainable Use License has no SPDX entry, so a package under it declares the custom reference `LicenseRef-Sustainable-Use-1.0` in its `license` field. The check treats every license that is not on its permissive list as restricted.
- **The earlier AGPL copies remain AGPL.** They can't be recalled, and this decision doesn't try to.
- **Apache-2.0 code stays free to redistribute.** The runner and the adapters can be copied and shipped by anyone under Apache-2.0. That is on purpose, since the value of those packages is that others write adapters and run runners.
- **The license is the protection, so it has to hold.** A legal review of the license, the licensor line and the CLA comes before launch (milestone 7).
- **Anything only the hosted version needs,** such as billing, still lives in separate services, not in the server packages.
