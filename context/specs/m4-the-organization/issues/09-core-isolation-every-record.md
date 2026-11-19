# 09: Core: isolation for every kind of record

Status: resolved
Builder: core
Blocked by: 05, 06
Features: F-049, F-087, F-003
Packages: `packages/db` (`src/testing/isolation-models.ts`), `packages/api` (the isolation suite), `packages/domain/src/access.ts`
Spec: `../spec.md`, sections 2 and 8; ADR 0053 ("Proving isolation for every kind of record"), ADR 0026

## What to build

- **The model list:** `isolation-models.ts` names every Prisma model with an `organizationId`, each with a fixture builder that makes a valid row (and its parents) in a given organization and, for project records, a given project. A short allowlist names the models without `organizationId` (the account tables, `DeviceCode`, `InstanceSetting`, `EmailSettings`, `ResetLinkGrant`), each with a one-line reason.
- **The guard:** a test reads Prisma's DMMF and fails when a model is on neither list, or on both.
- **The suite:** for each listed model, rows in organization A and organization B, where B is made by the fixtures (`seedOrganization`): v1's panel makes no second organization, since one team runs each install (2026-11-19, F-049; several organizations are F-134, after v1). Every tRPC procedure that lists or reads that kind (a table in the test maps each model to its procedures, and a second guard fails when a router gains a query procedure that's in no row) is called as a member of A, and B's IDs appear in no output. The same run as a member of A who can't open a restricted project of A checks every project record of that project.
- **The live stream and search** are in the suite: a subscription as a member of A receives no change notice of B's, and nothing of a hidden project.
- **The matrix:** a table of procedure × role (organization admin, organization member, project admin, project member, not listed) with the expected result, run in full. A refusal of a project the member can't open is `NOT_FOUND`.
- Ported from `spikes/auth-foundation/src/scenarios/isolation.ts` and `src/ostra/organization-scope.ts`.

## Done when

- [x] The suite passes over every model and every query procedure on `main`, milestones 1 to 4's included.
- [x] Break-it: a dropped organization filter in one router, and a model added without a fixture, each fail the suite; recorded in `context/proof/F-049.md` and `F-087.md`.
- [x] Tests named `it("F-049: ...")`, `it("F-087: ...")` and `it("F-003: ...")`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✅ prove isolation for every kind of record`.

## Comments

- 2026-11-19: `packages/db/src/testing/isolation-models.ts` lists the 75 models with `organizationId`, each with a fixture builder (its parents made once per organization, its project records once per project), and the allowlist of the 9 without it, each with its reason; `packages/db/src/isolation-models.test.ts` is the guard (models and fields parsed from `schema.prisma` and checked against the client's `Prisma.ModelName`) and builds every model in two organizations and a restricted project. `packages/api/src/isolation/every-record.test.ts` builds every model in A's open and restricted projects and in B, then calls all 57 query procedures (read from `appRouter._def.procedures`; a second guard fails on one with no row) as five roles (organization admin, organization member on the open project, the restricted project's admin and member, a member not listed on it): no output holds any ID of B's rows, nor, for the two roles that can't open the restricted project, any ID of its records. The same procedures called by A's admin with B's IDs find nothing (a project input is NOT_FOUND). The live stream sends a member no change notice of B's or of the restricted project, and `searchTasks` returns neither. The matrix is the 57 procedures by the five roles, written out and checked whole. `stream.subscribe` is the only subscription; mutations are each router's own tests. The readers table maps each model to the procedures that read it. A query procedure added later (tickets 25 to 29) needs its row here, which the guard asks for. Break-its: `runners.list` without its organization filter, `projects.list` without `visibleProjects`, and `Secret` off the model list each failed. `append-only.test.ts` (ticket 10) now lets test seams under a `testing/` folder seed audit entries, as the model list does. While this ticket waited, main gave `DeviceCode` an `organizationId` (F-103's organization binding) and the panel a new query, `agentProfiles.effortLevels`: both guards failed on the rebase, naming them, and each now has its builder and its row. Commit: b7157ae.
