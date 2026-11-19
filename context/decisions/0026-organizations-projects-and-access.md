# Organizations, projects and access

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Supersedes ADR 0010. Settles Q28, Q30, Q35 and Q102. **Amended 2026-11-18 after spike 9** (`research/spike-auth-foundation.md`): the first account creates the first organization, open sign-up is two settings, `owner` is refused, and the composite-key rule for every project record. **Amended again 2026-11-19** (the maintainer): the server seeds the first admin itself, `demo@demo.com` / `demo` unless the environment says otherwise, with a forced password change as its safety guard. This supersedes Q117's setup token (below, "The first admin"). **Amended again 2026-11-19** (the maintainer: "It will only be an app that people self host themselves for now"): open sign-up is no longer planned, and organization isolation stands on self-hosting alone. The data model doesn't change. **Amended again 2026-11-19** (the lead proposed it, and the maintainer answered "sure"): one team runs each install, with its clients as projects inside one organization, so v1 ships one organization per install. Creating more organizations, belonging to several with the switcher, links across organizations and the instance's Organizations page move after v1 (F-134). The organization stays a noun of the data model, every row keeps its `organizationId`, the isolation and its test for every kind of record stay in v1, and a fresh install still starts with its one organization (below, "One organization in v1").

ostra's data has two levels under the install: **Organization → Project**. Both exist from the first migration.

- **An install holds many organizations** (Q102), in the data model. v1 ships one (amended 2026-11-19, below).
  - A self-hosted install starts with one. The first account is the instance admin and the admin of that first organization, and can create more (after v1, F-134). **ostra creates that first organization together with the first account.** Spike 9 made the instance admin and left the creation of the organization to them, which Q102 doesn't say.
  - A member can belong to several organizations and switches between them in the sidebar (after v1, F-134).
  - **Open sign-up is not planned** (amended 2026-11-19). It was two settings, both off by default: open account sign-up (anyone may create an account) and open organization sign-up (an account may create organizations), which a hosted install would have turned on (spike 9, gotcha 11). It existed for the hosted version, and ostra is self-hosted only (ADR 0001, amended 2026-11-19). The two settings milestone 1 built, `OSTRA_OPEN_SIGNUP_ACCOUNTS` and `OSTRA_OPEN_SIGNUP_ORGANIZATIONS`, stay as built, off by default, with their lines in the configuration reference. Nothing more is built on them: no switch in the panel, and no feature's "done when" counts on them. Removing them would be a code change, with their columns dropped a release later (`AGENTS.md`).
  - **The server seeds the first account** when it starts with none (F-001, amended 2026-11-19): the instance admin and the admin of the first organization, from `OSTRA_ADMIN_EMAIL`, `OSTRA_ADMIN_USERNAME`, `OSTRA_ADMIN_PASSWORD` and `OSTRA_ORGANIZATION_NAME`, by default `demo@demo.com`, `demo`, `demo` and `Demo`. A fresh install is signed into, never claimed, so the setup token of Q117 is gone.
- **An organization** holds its members, its connections (its own GitHub App and Linear app), model providers, runner pools, agent profiles, budgets, memory notes and audit log (Q28).
- **A project** is a product the organization works on. It holds repos, boards, one environment, automations, memory notes, budgets and tasks. It picks a default agent profile per task kind and lists the runner pools it may use (F-086).
- **Every row carries its organization.** Records inside a project also carry the project. No query crosses organizations.

## One organization in v1

*Amended 2026-11-19.* ostra is self-hosted only (ADR 0001), and one team runs each install, with its clients as projects inside one organization. The lead proposed moving F-049's multi-organization features after v1, and the maintainer answered "sure".

- **Kept in v1 (F-049):** the organization as a noun of the data model, `organizationId` on every row and the project on every project record, the composite keys and the scoped store (below, "Consequences"); the one organization a fresh install starts with, seeded with the first account; and the guarantee that no query crosses organizations, with its test for every kind of record. The test makes its second organization from fixtures, since the panel makes none in v1.
- **After v1 (F-134):** the instance admin creating more organizations, a member belonging to several with the sidebar's switcher, links that resolve across organizations, and the instance's Organizations page. ADR 0053's "Several organizations" holds their design for then.
- **Why the model doesn't shrink with it:** adding organizations to the data model later is a rewrite (the option "One organization per install", below). With the noun, the column and the test in place, F-134 is panel and API work on a model that already holds several.

## The first admin

*Amended 2026-11-19.* The maintainer: "default setup user is demo@demo.com with password demo, unless specified otherwise in one of the environment variables."

- **Seeded at start.** The panel's runtime seeds the first admin when the server starts with no account (`seedFirstAdmin`, `packages/domain`): the account, its credential, the first organization with its default pool and built-in agent profile, and the admin membership, in one transaction. Several replicas starting at once take a Postgres advisory lock, so one admin is created and the others find it. An install that has an account is never seeded again, whatever the settings say later. The log records it by ID only.
- **The safety guard.** The default password is public, so an account seeded with it (`OSTRA_ADMIN_PASSWORD` unset) is flagged `mustChangePassword`. Its first sign-in leads to "Choose a new password", with the normal password policy (12 characters or more). Until it changes, every member procedure of the API and every better-auth route except signing in, signing out, reading the session and changing the password refuse it (`PASSWORD_CHANGE_REQUIRED`), so the default password can't invite anyone, approve a runner or change a setting, from the panel or past it. A changed password clears the flag.
- **Only the seed bypasses the length rule.** better-auth's minimum length would refuse `demo`, so the seed hashes it with better-auth's own `hashPassword` and stores it directly. Sign-in checks no length. Every other path (sign-up, a password change, a reset) keeps the policy, and an operator's own `OSTRA_ADMIN_PASSWORD` must meet it too.
- **For a demo**, `OSTRA_ALLOW_DEFAULT_PASSWORD=true` turns the forced change off. The panel then shows a warning banner on every page until the password changes. The configuration reference says never to set it on an install others can reach.
- **What it supersedes.** Q117 required a setup token, printed in the server's log at first start, to create the first account on a "Create the first admin" page, because a fresh install belonged to whoever reached it first. With the account seeded at start there is nothing to claim: the token, its setting `OSTRA_SETUP_TOKEN` and the page are gone, and `/setup` sends a visitor to sign in (the first-run checklist is on Home). The window Q117 closed is now the default password's, which the forced change closes instead.

## Access

A small fixed matrix, the same at both levels (Q35). Only `admin` and `member` exist. better-auth still accepts `owner` and its other built-in role names whatever is registered, so ostra's hooks refuse any role that isn't exactly one of the two, on an invitation, a role change and an organization's creator (ADR 0003). Spike 9 showed an `owner` invitation refused with `ROLE_NOT_FOUND`, and a test keeps the hook honest.

| Level | Roles | Who sees what |
|---|---|---|
| Organization | admin, member | Admins manage connections, providers, pools, profiles, budgets and members, and see every project |
| Project | admin, member | A project is open to the whole organization, or restricted to listed members. A project admin manages its repos, boards, environment and automations |

A member sees every task, conversations included, in the projects they can open (F-003). A restricted project's records are visible only to its members and the organization's admins. The audit log records changes at both levels (F-073).

SSO, SCIM, custom roles and groups come after v1 (F-004).

## The word

"Organization" replaces "team" as an ostra term (Q30). A Linear team is something else, and better-auth's own word is organization: its organization plugin maps to Organization (ADR 0003).

## Considered options

- **One level, the team (ADR 0010).** Rejected. "Team" collides with Linear's teams. One level also gives an organization with 18 projects no way to let each project run its own environment without making everyone an admin.
- **One organization per install.** Rejected. Adding organizations later is a rewrite of the data model, which is ADR 0010's own argument. One install can serve several organizations that must not see each other's credentials, members or work. *Changed 2026-11-19: the reason "the hosted version needs many on one install" is gone with the hosted version (ADR 0001), and the rejection stands on the other two.* *Changed again 2026-11-19: v1's product ships one organization per install (above, "One organization in v1"), but its data model doesn't, and this option was about the data model, so the rejection stands.*
- **Organization roles only, without project roles.** Rejected for the same reason: admins would have to edit every project's environment.
- **Custom roles or a fine-grained permission matrix in v1.** Rejected. F-049 demands a test, for every kind of record, that access holds. A fixed matrix of two roles at two levels can be tested that way. Custom roles can't.
- **A separate role for people who don't write code (Q70).** Rejected. They're ordinary members. An admin can limit an agent profile to some members, which is one field, not a role to test everywhere.
- **Agent profiles owned by each project.** Rejected for v1. One place that owns the agent setup is the brief's third job, "Control" (Q28). If projects need profiles the organization shouldn't see, profiles can also live in a project later.

## Consequences

- The first migration has Organization and Project, and the branded IDs `OrganizationId` and `ProjectId`.
- Every test that reads data also checks that another organization's data, and a restricted project's data, stay invisible (F-049, F-087). Since 2026-11-19 the other organization comes from fixtures, as v1's panel makes no second one.
- **The schema rule: a composite foreign key `(id, organizationId)` on every project-level record,** so a task can't point at a project of another organization even by mistake. Every query goes through a store that takes the member's scope and puts the organization in the `where`, and only a membership check makes a scope. The database backs the writes only: a raw read can still cross organizations, and only review, the scoped store and F-049's per-record test stop it. Spike 9's `isolation` scenario is the template for that test. **Row-level security** as a second wall behind the store is not in v1: it needs a non-superuser role and a `set_config` per transaction, and it is the first thing to add if an organization-crossing read is ever found.
- Each organization registers its own GitHub App and Linear app (ADR 0001, amended). Webhooks are routed by connection, not by one install-wide address.
- The environment belongs to the project, not to a repo (ADR 0038). A repo that sits in two projects has two sets of secrets, one in each environment.
- Ledger: F-002 becomes "Accounts", F-003 has roles at two levels, F-049 becomes "Several organizations" (renamed "Organization isolation" on 2026-11-19, with F-134 for the rest), and F-086 (projects) and F-087 (project access and roles) are new v1 rows.
- Glossary: Organization and Project are terms. Team leaves the glossary. Admin and Member exist at both levels.
- Revisit if an organization needs a read-only role before SSO arrives.
- A fresh install has a known account until its first sign-in. The forced password change, and the refusal of everything else until then, are what make that safe. An operator who exposes an install before signing in should set `OSTRA_ADMIN_PASSWORD` (2026-11-19).
