# 27: Core: the library: install by reference, pins, sources and secrets

Status: ready-for-agent
Builder: core
Blocked by: 02, 06
Features: F-145
Packages: `apps/core` (`library/`, new), `packages/domain` (bodies)
Spec: `../spec.md`, sections 4 ("A library install") and 5.4; ADR 0069 ("Sources, and the allowlist", "Installing")

## What to build

- **`resolveReference`,** an admin's look before installing, which writes nothing:
  - **GitHub:** resolve the ref to a commit through `CodeHostAdapter.resolveRef` (ticket 02), with the organization's installation's access when one covers the repo, else anonymously; read the tree with `readTree` within the caps; find each folder with a `SKILL.md`, at most four folders deep, for the admin to pick from (or the one `@skill` names); run `checkSkill` (ticket 06); compute `computedHash`.
  - **Well-known:** fetch `/.well-known/agent-skills/index.json` (then the legacy path), check each entry's `digest`, and refuse a mismatch, never falling back.
  - **A registry:** `GET <registry>/v0.1/servers/{name}/versions/latest`, tolerant of unknown fields. It checks `status` is `active`, keeps only `streamable-http` remotes, and lists each URL variable and header with whether it's secret. A packages-only entry and an `sse` remote are returned with the reasons they can't be installed.
  - Whether the source is on the allowlist.
- **`installItem`** (an organization admin):
  - it checks the allowlist (adding the source in the same call when the admin asked, with its own audit entry);
  - it fetches again at the same commit or version, and refuses when the hash changed since the look;
  - it writes the files as blobs (`library-file`, no task) and the `LibraryItem` with its first `LibraryItemVersion`, in one transaction with the audit entry.
- **A server's inputs:** each secret one is written through the secret store (ADR 0025's `SecretStoreAdapter`) and kept as a reference; a plain one on the version.
- **`testServer`:** a `tools/list` call from core to the remote with its headers, under a 10 s deadline. It stores the tools' names, and marks `needsOAuth` when the server answers with an OAuth challenge (a 401 with `WWW-Authenticate` naming resource metadata). A server with `needsOAuth` can't be attached (ticket 28).
- **Sources:** `addSource`, `removeSource`, and `library.seed-sources` adding `https://api.mcp.github.com` to every organization (on seeding, and once for each existing organization).
- **Outbound calls** go only to the source the admin named, with a fixed `User-Agent` of `ostra/<version>` and no other identifying header. None is made by itself except the update check (ticket 28).
- **Logs** carry the item's ID, kind and source kind, never a file's content, a header's value or a secret.

## Done when

- [ ] Tests named for `F-145`, against the fake code host, a fake well-known host, the fake registry and the stub MCP server:
  - a skill installed from a public repo at a commit with the CLI's hash;
  - a private repo through the installation, and refused without one;
  - a well-known digest mismatch refused (break-it: skip the digest check, and the case fails);
  - a source not on the list refused, and allowed once added;
  - a registry entry installed with its secret header in the secret store and nowhere else (searched by value);
  - a packages-only entry and an `sse` remote refused with their reasons;
  - the OAuth mark;
  - the hash changing between the look and the install refused;
  - each audit entry.
- [ ] The whole-repo checks pass, since this touches credentials (spec section 10).
- [ ] Committed as `✨ install library items by reference`.

## Comments
