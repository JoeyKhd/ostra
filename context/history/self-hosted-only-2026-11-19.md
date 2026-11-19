# ostra: self-hosted only

**Date:** 2026-11-19. **By:** Claude, on the maintainer's word.

**The maintainer:** "For now, forget that we will be selling this software as a cloud solution. It will only be an app that people self host themselves for now."

## The decision

ostra is an app that people host themselves, and no hosted version is planned. Until this date the plan held one for after v1: ADR 0001's "a paid hosted version comes later", which only the maintainer could offer (ADR 0048). It was never in v1 and no code was built for it, so this change takes planned work out and rewords reasons. It changes no code, no license text and no data model.

"For now" is part of the answer: a hosted version is not planned, not ruled out. If it comes back, it gets an ADR of its own, and this file is where its earlier reasoning is found.

## What was taken out of the plan

- **The hosted version** itself, the last item of "After v1" in `build-order.md` ("Later still"), and the line in milestone 7's spec that put it after v1. `project.md`'s non-goal now reads "No hosted version", where it said "No hosted version in v1. It comes later".
- **Open sign-up.** F-049 said "Open sign-up for new organizations is a setting, off by default", and ADR 0026 made it two settings, open account sign-up and open organization sign-up, "for the hosted version". A self-hosted install has no use for strangers making accounts or organizations, so:
  - F-049's "done when" loses the sentence, with a dated note in the row. Its scope is otherwise unchanged.
  - Milestone 4 builds no switch for either: ticket 24 (the instance pages' procedures, and `organizations.create`'s "or anyone when open organization sign-up is on"), ticket 33 (the instance pages, and "New organization" in the switcher), the spec's F-049 row, its proof table and screen 7, and the targets `instance-settings` (its "Creating organizations" and "Sign-up" sections) and `org-switcher` carry a dated note.
  - **The two settings milestone 1 built stay as built:** `OSTRA_OPEN_SIGNUP_ACCOUNTS` and `OSTRA_OPEN_SIGNUP_ORGANIZATIONS`, off by default, with their lines in `docs/configuration.md` and their columns on `InstanceSetting`. Nothing more is built on them. Removing them would be a code change, with the columns dropped a release later (`AGENTS.md`), and it isn't planned.
- **Later steps that waited on a hosted version:** pools shared between organizations (ADR 0029: "the hosted version may revisit that"), a database per group of organizations (ADR 0035), the organization in the URL for custom domains (ADR 0053), a single Jira app that ostra publishes (ADR 0047), and keeping what only a hosted version needs, such as billing, in separate services (ADR 0045, ADR 0048).

No telemetry or billing had been planned for a hosted offering: ADR 0021 ships no telemetry, and its line that usage would be learned "from the hosted version" is gone. No ticket in milestones 4 to 7 existed only for hosting. The open sign-up switches in tickets 24 and 33 were the only parts that did.

## What was reworded, with the decision unchanged

- **ADR 0001** now says that no hosted version is planned, and quotes the paragraph it replaces. Its consequences stand on self-hosting: the license keeps ostra self-hosted on its terms, and organization isolation stays because an install can serve several organizations and adding them later would rewrite the data model.
- **ADR 0048, `CONTRIBUTING.md` and `README.md`:** the license is the Sustainable Use License and Apache-2.0, as before. The contributor agreement stays, with the same grant: a license to the licensor on any terms, which covers commercial licenses and any other terms the licensor offers. Its text names no hosted version any more, so it is version 1.1. The licensor is unchanged.
- **ADR 0026:** "one organization per install" stays rejected, on the cost of adding organizations later and on installs that serve several. The hosted version was a third reason, and it's gone.
- **ADR 0017 and ADR 0021:** the decisions stand on their other reasons.
- **`project.md`, `GLOSSARY.md`, `AGENTS.md` and `features.md`'s header:** say that ostra is self-hosted only, and the instance admin no longer "decides whether sign-up for new ones is open".

## Kept as the record

These mention a hosted version as it was planned on their dates, and stay as written. Their points about a hosted version no longer apply, and the rest of each stands:

- ADR 0009 and ADR 0010, both superseded.
- `answers-2026-11-18.md` (Q102's open sign-up, the confidence notes on sandboxes and shared pools, the database per group of organizations) and `answers-2026-11-19.md`, sections 3 and 5 (the CLA and the licensor, argued partly from the hosted version's terms).
- In `research/`: `credential-proxy.md` (Anthropic's terms for a hosted ostra), `durable-execution.md` (DBOS on a hosted Postgres), `integrations-platform.md` (Nango's license against a hosted version) and `live-sync.md` (the watchers on a hosted install), as well as `spike-auth-foundation.md`, gotcha 11 (open sign-up as two settings).

**Revisit if:** the maintainer decides to offer ostra as a service. The contributor agreement already covers it, since its grant is on any terms.
