# Organizations, projects and access

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Supersedes ADR 0010. Settles Q28, Q30, Q35 and Q102. **Amended 2026-11-18 after spike 9** (`research/spike-auth-foundation.md`): the first account creates the first organization, open sign-up is two settings, `owner` is refused, and the composite-key rule for every project record.

ostra's data has two levels under the install: **Organization → Project**. Both exist from the first migration.

- **An install holds many organizations** (Q102).
  - A self-hosted install starts with one. The first account is the instance admin and the admin of that first organization, and can create more. **ostra creates that first organization together with the first account.** Spike 9 made the instance admin and left the creation of the organization to them, which Q102 doesn't say.
  - A member can belong to several organizations and switches between them in the sidebar.
  - **Open sign-up is two settings, both off by default:** open account sign-up (anyone may create an account) and open organization sign-up (an account may create organizations). A hosted install turns both on. Each has its line in the configuration reference (spike 9, gotcha 11). It exists for the hosted version (ADR 0001).
  - A fresh install belongs to whoever reaches it first, so the first account needs a setup token (F-001, Q117).
- **An organization** holds its members, its connections (its own GitHub App and Linear app), model providers, runner pools, agent profiles, budgets, memory notes and audit log (Q28).
- **A project** is a product the organization works on. It holds repos, boards, one environment, automations, memory notes, budgets and tasks. It picks a default agent profile per task kind and lists the runner pools it may use (F-086).
- **Every row carries its organization.** Records inside a project also carry the project. No query crosses organizations.

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
- **One organization per install.** Rejected. Adding organizations later is a rewrite of the data model, which is ADR 0010's own argument. The hosted version needs many on one install.
- **Organization roles only, without project roles.** Rejected for the same reason: admins would have to edit every project's environment.
- **Custom roles or a fine-grained permission matrix in v1.** Rejected. F-049 demands a test, for every kind of record, that access holds. A fixed matrix of two roles at two levels can be tested that way. Custom roles can't.
- **A separate role for people who don't write code (Q70).** Rejected. They're ordinary members. An admin can limit an agent profile to some members, which is one field, not a role to test everywhere.
- **Agent profiles owned by each project.** Rejected for v1. One place that owns the agent setup is the brief's third job, "Control" (Q28). If projects need profiles the organization shouldn't see, profiles can also live in a project later.

## Consequences

- The first migration has Organization and Project, and the branded IDs `OrganizationId` and `ProjectId`.
- Every test that reads data also checks that another organization's data, and a restricted project's data, stay invisible (F-049, F-087).
- **The schema rule: a composite foreign key `(id, organizationId)` on every project-level record,** so a task can't point at a project of another organization even by mistake. Every query goes through a store that takes the member's scope and puts the organization in the `where`, and only a membership check makes a scope. The database backs the writes only: a raw read can still cross organizations, and only review, the scoped store and F-049's per-record test stop it. Spike 9's `isolation` scenario is the template for that test. **Row-level security** as a second wall behind the store is not in v1: it needs a non-superuser role and a `set_config` per transaction, and it is the first thing to add if an organization-crossing read is ever found.
- Each organization registers its own GitHub App and Linear app (ADR 0001, amended). Webhooks are routed by connection, not by one install-wide address.
- The environment belongs to the project, not to a repo (ADR 0038). A repo that sits in two projects has two sets of secrets, one in each environment.
- Ledger: F-002 becomes "Accounts", F-003 has roles at two levels, F-049 becomes "Several organizations", and F-086 (projects) and F-087 (project access and roles) are new v1 rows.
- Glossary: Organization and Project are terms. Team leaves the glossary. Admin and Member exist at both levels.
- Revisit if an organization needs a read-only role before SSO arrives.
