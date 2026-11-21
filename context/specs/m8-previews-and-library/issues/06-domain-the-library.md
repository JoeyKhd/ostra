# 06: Domain: the library

Status: done
Builder: core (contracts, first)
Blocked by: 04
Features: F-145, F-146
Packages: `packages/domain`, `context/domain-model.md`, `docs/configuration.md`
Spec: `../spec.md`, section 5.4 (ticket 06's half) and the settings table; ADR 0069

## What to build

- **References.** `libraryReferenceSchema` parses the forms the `skills` CLI takes, as its `src/source-parser.ts` reads them (research §2.2):
  - `owner/repo`, `owner/repo@skill` and `owner/repo/path`;
  - a GitHub URL with `/tree/<ref>/<path>`;
  - any of them with `#ref`, and `@<40-hex>` as a commit;
  - a well-known site, `https://<site>`, with its index path found by the fetch;
  - `registry:<server name>`, optionally `@<registry URL>`.

  Each form has its test, and a form the CLI takes that ostra doesn't (a GitLab URL, a local path, an archive URL) is refused with words that say which sources ostra takes.
- **Formats a vendor owns,** each tolerant of unknown fields:
  - the registry's `server.json` subset (`name`, `version`, `remotes[]` with `type`, `url` and `headers[]` with `isSecret`, `packages[]` with `registryType`, and `_meta`'s official `status`);
  - the well-known index v0.2.0 with its `digest`;
  - skills.sh's search result (`source`, `skillId`, `name`, `installs`).
- **`computedHash(files)`,** the `skills` CLI's documented algorithm (research §2.5), with its README's test vectors written out in full in the test. One `SKILL.md` holding `# hi\n` hashes to the vector beginning `93c36952` and ending `2f55`.
- **`checkSkill(files)`:**
  - the Agent Skills spec's front matter: `name` at most 64 characters of lowercase letters, digits and dashes, matching its folder; `description` from 1 to 1,024 characters;
  - ostra's limits: 20 files, 1 MiB each, no path outside the folder, `SKILL.md` present once;
  - script-like files pointed out (under `scripts/`, a shebang, an executable bit), for the install dialog.
- **`allowed(source, sources)`,** matched by GitHub owner, GitHub repo, well-known host, or registry URL and namespace, never by name. Each kind has a near miss: an owner with the same prefix, a host's subdomain, a namespace's sibling.
- **Diffs:** `skillDiff(old, new)`, with files added, removed and changed and each text file's line diff, capped at 2,000 lines *(working value)*; and `serverDiff(old, new)`, with the version, the remote's URL, the headers asked for, the description and the tools' names.
- **`profileItems(profile, attached, everyProfile)`:** the profile's skills and servers at their pins, own and library alike, within the limits of 50 skills and 20 servers, refusing a name the profile already uses, with the refusal naming the profile.
- **Lifecycles,** each a discriminated union with exhaustive tests, drawn in `context/domain-model.md`:
  - a version: `available` → `current` | `dismissed`, then `current` → `superseded`;
  - a suggestion: `open` → `installed` | `dismissed`;
  - an item: installed → removed.
- **Use-case signatures:** those of spec section 5.4, ticket 06's list.
- **Jobs' names and keys:** `library.check-updates` and `library.seed-sources`.
- **Audit actions:**
  - `library.installed`, `library.attached`, `library.detached`, `library.every_profile_changed`;
  - `library.update_accepted`, `library.update_dismissed`, `library.removed`;
  - `library.source_added`, `library.source_removed`, `library.suggestion_decided`;
  - `organization.marketplace_search_changed`, `organization.public_preview_links_changed`.
- **Settings:** `OSTRA_LIBRARY_UPDATE_HOURS`, `OSTRA_MARKETPLACE_SEARCH` and `OSTRA_SKILLS_SEARCH_URL`, each with its default and its line in `docs/configuration.md`.

## Done when

- [x] Tests named for `F-145`:
  - the parser over every form;
  - the hash against the CLI's vectors (break-it: sort paths as UTF-16, and the vector fails);
  - `checkSkill`'s refusals;
  - `allowed` with every near miss, and a name that matches with a source that doesn't refused;
  - `profileItems` at each limit and with a clash;
  - the diffs.
- [x] Tests named for `F-146`: a search result with unknown fields parses, and one missing its source is dropped with a count.
- [x] `domain-model.md` draws the lifecycles, and the settings test passes.
- [x] Checks for the touched packages pass (spec section 10).
- [x] Committed as `✨ add the library domain`.

## Comments

- 2026-11-21, core: committed as `✨ add the library domain`, on milestone 8's migration (`3321f252`). Built in `packages/domain/src/library/`: `reference.ts` (`libraryReferenceSchema` and `parseLibraryReference`, in the order of the `skills` CLI's `src/source-parser.ts`; `librarySourceSchema`, strict, for `LibraryItem.source`, and `librarySourceKindOf` for its `sourceKind`), `vendor.ts` (the registry's `server.json` subset, its entries and their official status, a list's page; the well-known index v0.2.0; skills.sh's search, each list keeping the entries that read and counting the rest), `hash.ts` (`computedHash`, from the CLI's README and `src/skill-hash.ts`), `check-skill.ts` (`checkSkill`, with a small front matter reader for the top-level `name` and `description`, plain, quoted or as a `|` or `>` block, so no YAML dependency), `allowed.ts` (`allowed`, `allowlistEntryFor` for the dialog's "add this source", `allowlistEntryFromRow`, and `SEEDED_REGISTRY_SOURCE`), `diffs.ts` (`skillDiff` with Myers' line diff and three lines of context, `serverDiff`) and `profile-items.ts` (`profileItems`). The lifecycles are in `lifecycles/m8-library.ts`, typed by the migration's enums, with `...FromRow` mappers that switch over each enum, and drawn in `domain-model.md`. The use-case signatures are in `use-cases/m8-library-signatures.ts` (spec section 5.4's sixteen, plus `SeedSources`). The jobs `library.check-updates` and `library.seed-sources` are in `jobs.ts` and `packages/jobs`; the audit actions in `audit/actions.ts`; the settings `OSTRA_LIBRARY_UPDATE_HOURS`, `OSTRA_MARKETPLACE_SEARCH` and `OSTRA_SKILLS_SEARCH_URL` in `settings.ts` (`settings.library`) and `docs/configuration.md`. The library's branded IDs are in `packages/protocol/src/ids.ts`, and in `EntityId`. Tests: `library/library.test.ts` (the parser over every form and each refusal; the README's three vectors written out in full, and the UTF-8 sort, CRLF and exclusions; `checkSkill`'s refusals; `allowed` with every near miss and a name matched with a source that isn't; `profileItems` at both limits and with a clash; both diffs and the cap; the F-146 search result with unknown fields and dropped ones counted), `lifecycles/m8-library.test.ts` (every state against every input, and the rows) and `library/library-catalogue.test.ts` (the settings' defaults, the jobs' keys and payloads, the audit actions). Decisions: the update check's key is the organization and the start of its `OSTRA_LIBRARY_UPDATE_HOURS` window (`libraryUpdateWindowStart`), which is the day at the default of 24, so another setting keeps one check a window; a site is read over https only, and an `http:` address is refused with the other forms; `@v1.2.3` is a pin as the CLI reads it, as well as `@<40-hex>`; a direct `SKILL.md` URL is refused with the archive URLs; a current version's `decidedBy` is `null` for an install's first version; a description is counted in UTF-16 units. No break-it pass, under the maintainer's 2026-11-21 change: the hash's UTF-8 sort has its own case, which a UTF-16 sort fails. Checks: typecheck and lint of `packages/domain`, `packages/jobs`, `packages/protocol`, `apps/core` and `packages/api`; tests of the first three.
