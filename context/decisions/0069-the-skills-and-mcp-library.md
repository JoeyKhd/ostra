# The skills and MCP library

**Status:** accepted (2026-11-21). The maintainer approved the library on 2026-11-21 ("yes"), after asking on 2026-11-20: "who adds skills manually in 2026 lol, you just want the skills.sh marketplace or anything that can be installed using npx skills or something. is there a skills.sh equivalent for mcp's as well?" `research/skills-and-mcp-marketplaces.md` is the research. The lead settled its open questions by its recommendations on 2026-11-21: org admins install, members suggest, updates show a diff and wait for an admin, and the sources are GitHub's curated MCP registry plus any URL an admin names. Those and the rest under "Decided by the lead" are the lead's call, and the maintainer can still change them. Settles Q315 to Q324. Covers F-145 and F-146. **Amends** ADR 0021 (the server's new outbound calls), ADR 0025 (a code host reads a repo's files at a commit) and ADR 0049 (a profile's skills and MCP servers come from the library too).

**Not this ADR:** whether a task loads a repo's own `.agents/skills` and `.claude/skills`, and which skill wins when a profile's and a repo's share a name (research §1.4, §7.2, questions 2 and 3). That's being built separately (the `repo-skills` work, 2026-11-21) and lands as its own amendment to ADR 0049. The library follows whatever rule it sets for a library skill against a repo skill.

## Why

A profile's skills today are whatever an admin typed or uploaded: a name, a `SKILL.md` and up to 20 files, with no source, version or provenance (research §1.1). MCP servers are typed by hand. Every comparable product adds an organization layer that the `skills` CLI lacks: Cursor's team marketplace, Devin's organization installs, Claude's provisioned skills (research §4). The marketplaces themselves review nothing that ostra can rely on. The MCP Registry says "consumers should assume minimal-to-no moderation", and scans of skill registries found hundreds of malicious skills (research §5). So ostra installs by reference, pins what it installed, and makes every change wait for an admin.

Delivery was already right. Core copies a profile's skills into the task's blobs with a digest at every dispatch, and nothing in the box fetches anything, which works the same on `docker`, `kubernetes` and `host` (research §7.1). The library only fills those rows from a source.

## The library

**An organization's library holds items,** each a skill or an MCP server, with:
- its name, unique in the organization for its kind;
- its source (below);
- its **current pin**: for a skill, the commit it was fetched at and its content hash; for an MCP server, the registry entry's version, which the registry keeps immutable (research §3.1);
- its files (a skill's `SKILL.md` and up to 20 more, as blobs) or its server's endpoint (an MCP server's remote URL and headers);
- who installed it, and when;
- whether it's on **every profile**.

**A skill's hash is the `skills` CLI's documented `computedHash`:** a SHA-256 over each file's `path\0<length>\0<content>`, sorted by the path's UTF-8 bytes, with CRLF turned into LF in text files and `metadata.json`, `.git`, `__pycache__` and `__pypackages__` left out (research §2.5). ostra's hash then agrees with a repo's `skills-lock.json`, and the README's test vector is a unit test.

**ostra fetches and hashes in its own code** (Q318). It doesn't run the `skills` CLI: that would be a dependency, its telemetry is on by default, and it writes agent folders on a disk where ostra keeps blobs (research §7.4). The source parser, the fetch at a commit, finding `SKILL.md` files and the hash are small. skills.sh's own download path is never used.

## Sources, and the allowlist

**An item comes from one of:**
- **A GitHub repo:** `owner/repo`, `owner/repo@skill`, `owner/repo/path`, a GitHub URL with `/tree/<ref>/<path>`, or any of them with `#ref`. With no `@skill`, ostra lists the repo's skills (each folder with a `SKILL.md`, at most four folders deep) for the admin to pick from. A public repo is read anonymously. A private one is read through the organization's GitHub App when an installation covers it (ADR 0040, ADR 0065).
- **A well-known URL:** `https://<site>/.well-known/agent-skills/index.json`, falling back to `/.well-known/skills/index.json`. An entry's `digest` must match, and a mismatch is an error, never a fallback (research §2.2).
- **An MCP registry:** a server's name in a registry that speaks the official registry's `v0.1` API. GitHub's curated registry, `https://api.mcp.github.com`, is on every organization's list from the start. An admin adds any other registry by its URL (Q324). The official registry itself asks host applications not to call it directly, so it isn't on the list by default (research §3.1).

**An allowlist of sources, matched by source, never by name** (Q322). Each entry is a GitHub owner, a GitHub repo, a well-known host, or a registry's URL, optionally narrowed to a namespace such as `io.github.github/*`. Claude Code's and Copilot's docs both say a name "is not a security control" (research §1, summary 8).
- Every install, every update and every suggestion is matched against it.
- An install from a source that isn't listed asks the admin to add it in the same dialog, and the list says who added each one.
- A source taken off the list leaves its items installed, marked, and refuses their updates.

## Installing

**Organization admins install. Members suggest** (Q322).
- A member's suggestion is a reference and a note. Admins see a count on the library, never in amber, and install or dismiss each one.
- A suggestion from a source that isn't on the list says so.
- Devin's "Suggest MCP Integration" is the precedent (research §3.4).

**A skill's install:**
1. Core resolves the ref (a branch, a tag or a commit; a branch's head by default) to a commit.
2. It fetches the skill's folder at that commit, through the code host's new read capability (below) for GitHub, or the well-known index's URLs.
3. It checks `SKILL.md` against the Agent Skills spec: `name` at most 64 characters, lowercase letters, digits and dashes, matching its folder; `description` from 1 to 1,024 characters. It checks the files against ostra's limits: 20 files, 1 MiB each (ADR 0049).
4. It shows the admin the files, their sizes and the hash. A file that looks like a script (`scripts/`, a shebang, an executable bit) is pointed out, since a skill can tell the agent to run it (research §5.1).
5. The admin installs it.

**An MCP server's install** (Q320, Q321):
1. Core reads `GET <registry>/v0.1/servers/{name}/versions/latest` and checks the entry's `status` is `active` (research §3.1). It tolerates unknown fields, as for every format a vendor owns.
2. It offers the entry's **remote endpoints only:** a `remotes[]` entry of type `streamable-http`. An `sse` remote is refused as deprecated.
3. The admin fills each URL variable and each header. Every input marked `isSecret` goes into the secret store and is kept as a reference (ADR 0030). A plain one is kept on the item.
4. Core makes a test call to the server (`tools/list`, with the headers) and shows the names of its tools. A server that answers with an OAuth challenge is marked "needs sign-in, which ostra doesn't do yet" and can't be attached.
5. The admin installs it.

**What isn't installable in this milestone:**
- **An entry with only `packages[]`** (npm, PyPI, OCI and the rest, run over stdio). It's listed with the reason: running it needs a download in the box, which `docker`'s network forbids and which would break runner parity (research §6), or the server in a container of its own, which comes later. An admin can still add a stdio server by hand, whose command must already be in the image (ADR 0049).
- **OAuth sign-in for MCP servers.** Later, with its own ADR: a broker in core, whose grant (per organization or per member) is the open question (research §7.6, question 9).

## Attaching

**Items attach to agent profiles** (Q315). One install serves many profiles. An item marked **every profile** is on every profile of the organization, the built-in Refine and Review profiles included, and a profile's editor shows it as inherited.
- **Projects don't attach items.** They pick profiles, as now (ADR 0049).
- **Nothing attaches to a single task.** No product the research read does, and it would let any member widen a task (research §4).

**The limits count everything:** a profile's own skills, its attached items and the every-profile items together stay within 50 skills and 20 MCP servers (ADR 0049). An attach, or a switch to every profile, that would pass a limit is refused, and the refusal names the profile.

**A name a profile already uses is refused at attach.** For a skill that's the profile's own skill of that name. For a server, the profile's own server of that name. A library item and a repo's own skill of the same name follow the `repo-skills` work's rule.

**A library MCP server starts as not read-only:** a registry has no trustworthy read-only flag (research §6). So plan mode leaves it alone, and "Reaching the network" asks before its tools (ADR 0049). An admin can mark it read-only, with an audit entry (`library.read_only_changed`, added 2026-11-21 by ticket 28).

**A server never tested is tested at attach** (ticket 28, 2026-11-21). An install makes no test call, so a server whose version lists no tools gets its test call when an admin attaches it or puts it on every profile; one that answers with an OAuth challenge is marked then, and refused. "Every profile" checks every profile that isn't archived; an archived one's reopened tasks get what still fits.

**A dispatch never refuses a task for the library** (ticket 28). The profile's own skills and servers come first; a library item that no longer fits (an own skill of its name added since, a limit passed) or a server that now asks for a sign-in is left out of that session and logged by its ID.

**The profile editor keeps the same rules** (ticket 30, 2026-11-21). A save that gives the profile an own skill or server named like a library item attached to it or on every profile, or that passes a limit with the library's items counted, is refused, naming the library item. So the editor never makes a profile whose dispatch would leave a library item out.

## Delivery: unchanged

- **Nothing is fetched in the box.** At each dispatch, core reads each profile's skills (its own, attached and every-profile) at their current pins, and copies their files into the task's blobs with their digests, as today (ADR 0049). The runner checks each digest. The same path runs on every executor, so runner parity holds.
- **A library MCP server is an HTTP server behind the sidecar's MCP proxy,** with its URL and its secret headers in the task's credentials (ADR 0030, ADR 0049). The agent's config names the proxy's path, never the URL or a header.
- **The OpenCode adapter writes `oauth: false` for every proxied server,** so OpenCode never starts a sign-in inside the box (research §7.2, fix 3).
- **Only a server's secret headers are searched for** (2026-11-21, a follow-up to ticket 28). Before the agent starts, the runner refuses an environment or a launch file that holds a credential (ADR 0030), and it searched for every header value of 8 characters or more. A registry entry's fixed header (a version or a tenant) or a plain input is no secret, so one whose value also sat in the agent's environment refused the session; ticket 28's first OpenCode run hit it. The credentials now name a library server's plain headers (`plainHeaders`, protocol minor 7: an optional field added while minor 7 is unreleased, as `agent.repoSkills` was added to minor 6), the proxy sends them as before, and the check searches for the rest. A header is a secret when its input is kept in the secret store, because the entry marks it secret or the admin gave it as one. No names mean every header is a secret: a profile's own server, and every server a minor-6 runner is sent, which keeps searching for each.

## Updates

**An update waits for an admin, with its diff** (Q323).
- **The check.** A job checks each item once a day (`OSTRA_LIBRARY_UPDATE_HOURS`, 24) and when an admin presses "Check for updates":
  - for a skill, it resolves the item's ref again, and fetches when the commit moved and the hash changed;
  - for an MCP server, it reads the registry's latest version.
- **What's found** is an update on the item, with:
  - for a skill, the files added, removed and changed, and each changed file's text diff;
  - for a server, the changed fields of its entry (the version, the remote's URL, the headers asked for, the description) and the tools a fresh test call lists.
- **The admin decides.** "Accept" makes it the current pin. "Dismiss" leaves the item where it is, and the next newer one shows again.
- **Nothing moves by itself.** Socket, one of skills.sh's own audit partners: "skills can become malicious at any point" (research §2.6).
- **A running task gets the accepted pin at its next session,** as a profile edit does today (ADR 0049).
- **One update waits at a time, and an accept names what the admin saw** (ticket 28, 2026-11-21). Each find is a new version; a newer one found while one waits takes its place (the waiting one → `superseded`), so an admin's accept of the one they read is refused once a newer one came. Content found before, waiting or dismissed, isn't found again: a dismissed update stays dismissed until different content comes. A version ostra wouldn't install (a skill that fails its checks, a registry version with no streamable-HTTP remote) isn't offered.
- **A server's update keeps the item's inputs by name** (ticket 28): its secret ones as the same references, a plain one the new version marks secret moved to the secret store. A new version that asks for an input the item lacks is shown and can't be accepted; installing it again gives the input.
- **The check's schedule** (ticket 28): each organization with an installed item gets one check in each window of `OSTRA_LIBRARY_UPDATE_HOURS` (from midnight UTC), sent ahead and held until the window begins, keyed by the organization and the window.
- **What no version in use needs goes, once a day** (2026-11-21, a follow-up to ticket 28). A version is in use while its item is installed and it's current or waiting for an admin. `library.cleanup`, a daily schedule like `blob.gc`, goes through every organization that has or had an item:
  - it deletes each library file (`library-file`, no task) that no version in use names and no profile's own skill names: a superseded or dismissed version's files, a removed item's, and a file an install or a check stored and never wrote a version for;
  - it deletes each secret input a version out of use names and none in use does: a removed server's, and one a dismissed update moved to the secret store;
  - the version rows stay, so a dismissed update stays dismissed, but a superseded or dismissed version's files can't be opened once they're gone.
  - Nothing an open task needs goes. A dispatch copies a library skill's files into the task's own blobs, which go only with the task, so a running session never reads the library's again. The one read in flight is a dispatch or a credentials request that read a version just before an admin moved it: nothing of an item goes until the item has stood still for 15 minutes *(working value)*, and no file goes in its first 15 minutes, while the install or the check that stored it writes its version.
  - It's idempotent: a second pass deletes nothing more, a secret already gone counts as done, and what a store refused waits for the next day. Its line carries counts and IDs only.
- **A server that changes its tools without a new version** (a "rug pull", research §7.4) isn't caught by this. A hash of its `tools/list` in the MCP proxy comes later.

## The marketplace browser (F-146)

**Admins search through core, never from the browser** (ADR 0021, "Browsers never call a third party"). The library's "Browse" page searches:
- skills on skills.sh, through `GET https://skills.sh/api/search?q=…` (`OSTRA_SKILLS_SEARCH_URL`), which answers with no token and returns each skill's source, name and install count. It isn't a documented public API: skills.sh's documented v1 API takes only a Vercel OIDC token, so an app has to run on Vercel to use it (research §2.6). The page says so. When the search fails, the page says it's unavailable, and installing by reference still works (Q317);
- MCP servers in each registry on the organization's list, through `GET <registry>/v0.1/servers?search=…&version=latest`.

**A result installs through the same flow,** with the same allowlist, the same checks and the same pin. It shows its source, its install count on skills.sh or its version in the registry, and whether its source is on the list.

**It's off by default** (Q316). An organization admin turns it on, and `OSTRA_MARKETPLACE_SEARCH=false` keeps it off on the whole install. A search sends the admin's words to skills.sh or the registry, so the switch says so.

**Which server makes the calls** (ticket 30, 2026-11-21). The library's bodies are the domain's, and the panel's procedures run them on the panel's server, as core's jobs run them on core. So the look, the install, the test call and the search leave from ostra's server, never from the browser, with the same `User-Agent` and redirect rules, and a skill's files reach core's blob service through its panel blob endpoint (purpose `library-file`). The panel sends a search's words in a request's body, never in a URL, so no access log holds them.

**No third-party audit is shown** (Q319). skills.sh's audit verdicts come from its OIDC API or from the CLI's lookup, which telemetry gates. ostra can't run an LLM audit itself, since it never calls a model. The library shows what it knows: the source, the commit, the hash, the files and who installed it.

## ADR 0021, amended

The server makes four kinds of outbound call it didn't before. None carries usage data:
- **Fetching an item** from its source, when an admin installs it or checks for updates. This is a call the organization sets up itself, as its tracker and code host are.
- **The daily update check** of each installed item, against the source the admin chose. An organization with no items makes none.
- **The test call** to an MCP server an admin installs.
- **The marketplace search,** only while an admin has it on, and only with the admin's own words.

The models.dev catalog is still the only fetch the server makes on its own with nothing set up.

## ADR 0025, amended

`CodeHostAdapter` gains an optional capability, `readTree`:
- `resolveRef(access | null, repo, ref)` → a commit;
- `readTree(access | null, repo, commit, path, limits)` → the files under the path, with their sizes and modes, capped by count and bytes.

`access` is `null` for a public repo read anonymously. GitHub declares it, through its tarball endpoint at a commit. A code host that lacks it declares so, and an install from it is refused with the reason. Its contract cases run against the fake code host.

## Decided by the lead

On the research's recommendations, 2026-11-21, which the maintainer can change:
- **An organization library attached to profiles,** with "every profile"; projects pick profiles; nothing per task (Q315).
- **Installs and update checks** are calls the organization sets up; **the marketplace search** is off by default, an admin's switch, and an instance can disable it (Q316).
- **The skills search** is skills.sh's CLI endpoint, through core, with install by reference never depending on it (Q317).
- **ostra's own code** for the fetch, the discovery and the CLI's documented hash (Q318).
- **No third-party audits** shown in this milestone (Q319).
- **Remote MCP servers only;** stdio servers in a container of their own come later (Q320).
- **No OAuth sign-in yet;** a server that asks for it is marked and can't be attached (Q321).
- **Org admins install, members suggest,** and sources are matched by source (Q322).
- **Updates show a diff and wait for an admin,** and running tasks get them at their next session (Q323).
- **Sources:** GitHub's curated MCP registry, plus any registry URL an admin names (Q324).

## Later, each with its own ADR

- OAuth sign-in for remote MCP servers: a broker in core, Client ID Metadata Documents, tokens in the secret store, and whose grant.
- stdio MCP servers in a container of their own beside the box, bridged to HTTP through the MCP proxy, which adds a recorded difference on `host`.
- A hash of each server's tool list in the MCP proxy, reported when it changes.
- Third-party audit verdicts, if skills.sh's API opens up.
- Network allowlists (F-052), before a `kubernetes` box runs a library server with public egress.

## Considered options

- **Install into each profile directly** (the research's design A). Rejected: each profile would keep its own copy, and an update would be N edits.
- **Run `npx skills` in core or in the box.** Rejected: a dependency, telemetry on by default, a fetch in the box that `docker` can't make, and folders on a disk.
- **Let a project or a task attach items.** Rejected (Q315).
- **Updates that apply themselves.** Rejected (Q323).
- **Call the official MCP Registry directly.** Rejected: it asks hosts not to. An admin can still add it by URL.
- **skills.sh's documented API.** Not possible: it takes only a Vercel OIDC token.
- **Fetch an MCP package at box start** (`npx -y`, `uvx`). Rejected: `docker`'s network forbids it, and it would break runner parity.

## Consequences

- The schema gains the library's items, their versions and updates, the profiles' attachments, the allowlist and the suggestions (milestone 8's migration). A profile's own skills and servers stay as they are.
- A profile's editor shows three kinds of skill and server: its own, attached, and inherited from every profile.
- An item's removal detaches it everywhere, and tasks lose it at their next session.
- The audit log records each install, attach, detach, every-profile switch, update accepted or dismissed, removal, allowlist edit, suggestion decided, and the search switch, with names and never content.
- A library skill is untrusted text the agent reads. The box contains the agent (ADR 0031), and the library's pin, diff and admin step are what keep a changed skill from arriving unseen.
