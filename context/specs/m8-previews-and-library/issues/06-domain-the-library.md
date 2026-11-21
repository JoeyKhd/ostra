# 06: Domain: the library

Status: ready-for-agent
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

- [ ] Tests named for `F-145`:
  - the parser over every form;
  - the hash against the CLI's vectors (break-it: sort paths as UTF-16, and the vector fails);
  - `checkSkill`'s refusals;
  - `allowed` with every near miss, and a name that matches with a source that doesn't refused;
  - `profileItems` at each limit and with a clash;
  - the diffs.
- [ ] Tests named for `F-146`: a search result with unknown fields parses, and one missing its source is dropped with a count.
- [ ] `domain-model.md` draws the lifecycles, and the settings test passes.
- [ ] Checks for the touched packages pass (spec section 10).
- [ ] Committed as `✨ add the library domain`.

## Comments
