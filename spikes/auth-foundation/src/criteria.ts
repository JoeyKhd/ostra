// The rows of the report, named once. The harness records a result under each
// title, and the mutation check names the title that must turn FAIL, so the
// two cannot drift apart: a typo here is a type error there.

/** The pass bar of spike 9, one entry per bullet of context/build-order.md, in the order they run. */
export const passBar = {
  typecheck: "Strict typecheck passes",
  pinned: "the version is pinned exactly",
  prismaOnPostgres: "With Prisma 7 on Postgres",
  signUp: "sign up",
  signIn: "sign in by username and by email",
  inviteLink: "an invite link with no mail server",
  twoOrganizations: "two organizations with one member in both",
  resetLink: "an admin's reset link",
  deviceCode: "a device-code sign-in for a personal runner",
  isolation: "A member of one organization can't read the other's rows",
  contractTest: "a contract test (sign up, session, role) is green",
} as const;

/** What the decisions under test need beyond the pass bar, and the harness's own honesty checks. */
export const beyond = {
  roles: "ADR 0026, Q35, Q102: two organization roles, a separate instance admin, organization creation gated",
  firstAccount: "Q102: the first account is the instance admin, even when several arrive at once",
  ownPostgres: "the same run on a Postgres of your own (not the embedded one)",
  eslint: "AGENTS.md type rules, by ESLint (the repo's rule set, strict-type-checked)",
  scan: "AGENTS.md type rules that tsc cannot see (a scan, a second net behind ESLint)",
  leftovers: "no postgres process or cluster data left behind by this run",
} as const;

export type PassBarTitle = (typeof passBar)[keyof typeof passBar];
export type BeyondTitle = (typeof beyond)[keyof typeof beyond];
export type CriterionTitle = PassBarTitle | BeyondTitle;
