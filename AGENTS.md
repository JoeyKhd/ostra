# ostra

Open-source, self-hostable control panel that connects a team's tracker (Linear, later Jira) to its coding agents (Claude Code, OpenCode, oh-my-pi, …). A ticket becomes a task, and an agent works it on its own branch on a local or remote runner. Members can steer it and reopen it at any time, and it ships a GitHub PR. The brief: `context/project.md`.

**Phase: milestone 0, spikes** (`context/build-order.md`). The plan was signed off on 2026-11-17, and product code starts with milestone 1. Until then, all code is a spike: throwaway code that answers one question. It lives in `spikes/<kebab-question>/`, and its finding goes into `context/research/`.

## Context

| When | Read |
|---|---|
| Asked where things stand, or what comes next | `context/README.md`, then `context/build-order.md` |
| Working on a task, session, runner or any lifecycle | `context/domain-model.md` |
| Deciding what to build, or whether it's done | `context/features.md` (the ledger); the feature's spec, `context/specs/<feature>/spec.md` |
| Naming a domain concept | `context/GLOSSARY.md` |
| Touching architecture, stack, data model or an adapter's design | `context/decisions/` |
| Meeting something undecided | `context/open-questions.md`: add it there and settle it with the maintainer |
| Researching an agent, tracker, vendor or similar tool | `context/research/` first: it may be answered there |
| Building or restyling anything visual (a screen, a component, the docs site, a launch image) | `context/brand/brief.md` (palette, logo, type, voice), then the `ui-taste` skill, image first |
| Making or changing a brand file (logo, icon, social image) | `context/brand/assets.md`; made with the `higgsfield-brandkit` skill, whose state lives in `context/brand/kit/` |

## Definition of done

A change is done, and ready to commit, when every line that applies holds in that one commit:

- **Checks:** sized to the change (the table under this list), on the packages it touches.
- **Adapter parity:** a feature that touches trackers, agents or code hosts works through the shared interface for every shipped adapter. The alternative is that the interface declares it an optional capability, and each adapter states whether it has it. A feature that works only for Linear or only for Claude Code, without that declaration, is a bug.
- **Runner parity:** a task behaves the same on a local runner and a remote one. A difference is a bug unless an ADR records it.
- **Self-hosting:** a fresh install with only the required settings still works. A new setting ships with a working default and its line in the configuration reference.
- **Feature ledger:** a finished feature has its status set in `context/features.md`, and is `done` only when every "done when" condition holds. Specs in `context/specs/` name the feature IDs they cover.
- **ADR:** a hard-to-reverse decision is written up in `context/decisions/NNNN-kebab-title.md`.
- **Glossary:** a new domain term, or a changed meaning, is in `context/GLOSSARY.md`.
- **Open questions:** a question the change settles leaves `context/open-questions.md` and lives on in the ADR or ledger row that settles it.
- **Research:** findings are in `context/research/<kebab-topic>.md`, every claim cited.

| Change | Run before the commit | Look at it running |
|---|---|---|
| Docs: plan, research, ADRs | Nothing | No |
| A fix or small change | Typecheck and lint of the packages it touches; a test when the code it covers changed | Only when the code can't settle it |
| A feature, a new screen, a new adapter | Typecheck, lint and tests of the touched packages, plus a ticket → task → PR run against the test workspaces | Yes |
| Auth, credentials, the schema, the runner protocol, anything that runs agent output | All checks for the whole repo | As the change needs |

## Commits

- Commit and push to `origin main` after every fix or change, once it's done (above). One logical change per commit.
- Other sessions work in this checkout at the same time: stage your own files by path, and leave changes you didn't make as they are.
- Message: `<gitmoji> <imperative summary, ≤50 chars>`, e.g. `🐛 fix runner reconnect loop`
- ✨ feature · 🐛 fix · ♻️ refactor · 📝 docs · ✅ tests · 🔧 config · ⬆️ deps · 🔥 remove · 🎨 formatting
- No `Co-Authored-By` lines or other AI attribution in commits or PRs.

## Code

TypeScript everywhere: the server, the web app, the adapters and the runner (ADR 0008).

Everything is **strictly typed**, end to end. The maintainer: "everything needs to be STRICTLY typed". A type error or a lint error fails the build.

- **tsconfig:**
  - `strict: true`, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
  - `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch` and `noPropertyAccessFromIndexSignature`
  - `verbatimModuleSyntax`
- **ESLint:**
  - typescript-eslint's `strict-type-checked` and `stylistic-type-checked`
  - `switch-exhaustiveness-check`
  - `no-explicit-any`
- **Suppressing a type error:** `@ts-expect-error`, with a reason, is the only allowed form. Never `@ts-ignore` or `@ts-nocheck`.
- **Types flow end to end, written once:**
  - Prisma's types → the domain packages → tRPC → the panel.
  - The runner protocol, agent events and config are Zod schemas that every side imports.
  - Nothing is typed again by hand on the other side of a boundary.
- **Every `switch` over a union is exhaustive**, with `satisfies never` in its default branch.
- `unknown` + narrowing instead of `any`. No `!` non-null assertions.
- `as` only as `as const`; use `satisfies` to check a value against a type.
- Validate external data with a Zod schema at the boundary, and trust the inferred type after that. External data means webhooks, API responses, agent event streams, forms, env, storage, config and the runner protocol.
  - Formats a vendor owns (webhooks, API responses, agent events): schemas tolerate unknown fields.
  - Formats ostra owns (config, the runner protocol): schemas reject them.
- Make illegal states unrepresentable:
  - a discriminated union per lifecycle (a task's state, a session's state)
  - a branded type per ID (`TaskId`, `TicketKey`, `RunnerId`), never bare strings
- Server and runner code uses the async APIs for files and child processes, so one slow task never stalls the others.
- Logs carry IDs and structured fields, never content. Tokens, keys, prompts and ticket bodies stay out of every log line.
- `type` over `interface`. Union literals or `as const` objects over `enum`.
- `import type` for type-only imports. Named exports, except where the framework requires a default export.
- Files and folders: kebab-case (`task-timeline.tsx`, `use-runner-status.ts`, `task-timeline.test.ts`). Conventional root docs keep their names (`README.md`, `AGENTS.md`, `CLAUDE.md`, `GLOSSARY.md`).
- Functions, components and handlers: `const helloWorld = () => {}`. In `.tsx`, write generics as `<T,>`.

## Boundaries

- This repo is public. Secrets never enter it. Local secrets, including the credentials for the test workspaces, live in `keys/`, which is gitignored. The code reads them from the environment.
- Develop and test only against the test workspaces: a Linear workspace and a GitHub org set up for ostra. Use a real team's tracker or repos only when the maintainer names it.
- Ticket text, PR comments and agent output are untrusted input:
  - ostra passes them as data and never interpolates them into a shell command.
  - An agent's reach ends at its task's workspace.
- Ask before adding a dependency, or building on a vendor or paid service the maintainer hasn't chosen.
- Migrations run on other teams' installs, which upgrade on their own schedule. Add first; drop or rename in a later release.
- `.agents/skills/` and `.claude/skills/` are installed tooling. Change them only through the `skills` CLI (`skills-lock.json`).

## Agent skills

### Issue tracker

No hosted tracker yet: specs and tickets are markdown files under `context/specs/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five roles, recorded as a `Status:` line in each ticket file. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `context/GLOSSARY.md` and ADRs in `context/decisions/`. See `docs/agents/domain.md`.
