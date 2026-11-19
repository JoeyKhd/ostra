# 34: API: agent profiles and project defaults

Status: ready-for-agent
Builder: api
Blocked by: 07
Features: F-021, F-026 (the rules), F-063 (the switch)
Packages: `packages/api` (`routers/agent-profiles.ts` (new), `routers/projects.ts`, `routers/tasks.ts`), `packages/domain` (bodies of `saveAgentProfile`, `archiveAgentProfile`, `profilesForMember`, `setProjectDefaultProfile`)
Spec: `../spec.md`, sections 2 (F-021) and 11 (items 2, 6, 7); ADR 0049

## What to build

- **`agentProfiles.list`, `.get`** (any member sees the profiles they may use; an organization admin sees all), **`.save`**, **`.archive`** (organization admins only): name, agent (an adapter from the registry), model (one of the organization's providers' models), instructions, skills (name, `SKILL.md` text, up to 20 files of at most 1 MiB, uploaded as blobs), MCP servers (HTTP: URL and headers, each header value a secret written to the secret store and shown back only as "set"; stdio: command, arguments, non-secret variables), approval rules (validated by the protocol's schema, with the domain's presets offered by `.presets`), plan first, and who may use it (`everyone`, or listed members). An audit entry for each change.
- **The built-in profile** stays, editable but not archivable.
- **`projects.setDefaultProfile`** per task kind (project admins, which is every organization admin until F-087), limited to profiles open to every member of the project.
- **`tasks.create` and the Inbox's start** take an optional profile, checked against `profilesForMember`; a refused profile is `FORBIDDEN` with its name. The start form's options come from `agentProfiles.forStart(projectId, kind)`: the member's profiles, the project's default first.
- **`agentProfiles.ruleCoverage`:** for the editor, what a rule covers on sample subjects (the domain's matcher), so the panel can say "asks for `pnpm add`, not for `pnpm test`".

## Done when

- [ ] Tests: an admin creates, edits and archives; a member can't; a listed profile is invisible and refused for an unlisted member; header secrets are stored as refs and never returned; a default must be open to the project; a task started with a profile records it; another organization's profiles are invisible.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `api` and `domain`.
- [ ] Committed as `✨ add the agent profiles API`.

## Comments
