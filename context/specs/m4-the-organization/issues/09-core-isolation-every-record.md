# 09: Core: isolation for every kind of record

Status: ready-for-agent
Builder: core
Blocked by: 05, 06
Features: F-049, F-087, F-003
Packages: `packages/db` (`src/testing/isolation-models.ts`), `packages/api` (the isolation suite), `packages/domain/src/access.ts`
Spec: `../spec.md`, sections 2 and 8; ADR 0053 ("Proving isolation for every kind of record"), ADR 0026

## What to build

- **The model list:** `isolation-models.ts` names every Prisma model with an `organizationId`, each with a fixture builder that makes a valid row (and its parents) in a given organization and, for project records, a given project. A short allowlist names the models without `organizationId` (the account tables, `DeviceCode`, `InstanceSetting`, `EmailSettings`, `ResetLinkGrant`), each with a one-line reason.
- **The guard:** a test reads Prisma's DMMF and fails when a model is on neither list, or on both.
- **The suite:** for each listed model, rows in organization A and organization B; every tRPC procedure that lists or reads that kind (a table in the test maps each model to its procedures, and a second guard fails when a router gains a query procedure that's in no row) is called as a member of A, and B's IDs appear in no output. The same run as a member of A who can't open a restricted project of A checks every project record of that project.
- **The live stream and search** are in the suite: a subscription as a member of A receives no change notice of B's, and nothing of a hidden project.
- **The matrix:** a table of procedure × role (organization admin, organization member, project admin, project member, not listed) with the expected result, run in full. A refusal of a project the member can't open is `NOT_FOUND`.
- Ported from `spikes/auth-foundation/src/scenarios/isolation.ts` and `src/ostra/organization-scope.ts`.

## Done when

- [ ] The suite passes over every model and every query procedure on `main`, milestones 1 to 4's included.
- [ ] Break-it: a dropped organization filter in one router, and a model added without a fixture, each fail the suite; recorded in `context/proof/F-049.md` and `F-087.md`.
- [ ] Tests named `it("F-049: ...")`, `it("F-087: ...")` and `it("F-003: ...")`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✅ prove isolation for every kind of record`.

## Comments
