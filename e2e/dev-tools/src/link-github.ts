import type { Db } from "@ostra/db";
import { postgresAuditLog, seedingAllowed } from "@ostra/domain";
import { memberIdSchema, organizationIdSchema } from "@ostra/protocol";

// The dev GitHub link (milestone 4, ticket 40; ADR 0053 "For development only"): writes an
// account's verified GitHub link as F-119's OAuth callback would (`githubUserId`, `githubLogin`,
// `githubLinkedAt`), for a test user whose GitHub sign-in can't be clicked through, so the
// independent-review check (F-104) and the reviewer demo can map a review to a member. The GitHub
// user's numeric ID comes from GitHub's API. Each of the account's organizations gets an audit
// entry that names the dev tool. Development and test only.

export type LinkGitHubDeps = {
  readonly db: Db;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  /** GitHub's REST API. Default: `https://api.github.com`. */
  readonly apiUrl: string;
  /** The test token from `github-test.env`, or `null` to ask GitHub without one. Never logged. */
  readonly token: string | null;
  readonly now: () => number;
};

export type LinkGitHubResult =
  | { readonly ok: true; readonly githubUserId: string; readonly githubLogin: string; readonly audited: number }
  | { readonly ok: false; readonly error: "not-development" | "no-account" | "no-github-user" | "linked-to-someone-else"; readonly message: string };

/** The GitHub user's numeric ID and login as GitHub spells it. */
const githubUserOf = async (deps: LinkGitHubDeps, login: string): Promise<{ readonly id: string; readonly login: string } | null> => {
  const response = await deps.fetch(`${deps.apiUrl.replace(/\/+$/, "")}/users/${encodeURIComponent(login)}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "ostra-dev-tools",
      ...(deps.token === null ? {} : { authorization: `Bearer ${deps.token}` }),
    },
  });
  if (!response.ok) {
    return null;
  }
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const id: unknown = Reflect.get(body, "id");
  const found: unknown = Reflect.get(body, "login");
  return typeof id === "number" && Number.isInteger(id) && typeof found === "string" ? { id: String(id), login: found } : null;
};

export const linkGitHubForDev = async (deps: LinkGitHubDeps, input: { readonly username: string; readonly githubLogin: string }): Promise<LinkGitHubResult> => {
  if (!seedingAllowed(deps.env)) {
    return { ok: false, error: "not-development", message: "The dev GitHub link runs only when NODE_ENV is development or test" };
  }
  const account = await deps.db.user.findFirst({ where: { username: input.username.toLowerCase() }, select: { id: true } });
  if (account === null) {
    return { ok: false, error: "no-account", message: `No account has the username ${input.username}` };
  }
  const github = await githubUserOf(deps, input.githubLogin);
  if (github === null) {
    return { ok: false, error: "no-github-user", message: `GitHub has no user ${input.githubLogin}` };
  }
  return deps.db.$transaction(async (tx) => {
    const holder = await tx.user.findFirst({ where: { githubUserId: github.id, NOT: { id: account.id } }, select: { id: true } });
    if (holder !== null) {
      return { ok: false, error: "linked-to-someone-else", message: "That GitHub account is linked to another ostra account" } as const;
    }
    await tx.user.update({ where: { id: account.id }, data: { githubUserId: github.id, githubLogin: github.login, githubLinkedAt: new Date(deps.now()) } });
    const memberships = await tx.member.findMany({ where: { userId: account.id }, select: { id: true, organizationId: true } });
    for (const membership of memberships) {
      await postgresAuditLog.recordInTx(tx, {
        organizationId: organizationIdSchema.parse(membership.organizationId),
        projectId: null,
        actor: { kind: "system", id: null },
        action: "github.linked",
        entity: "member",
        entityId: memberIdSchema.parse(membership.id),
        data: { githubUserId: github.id, via: "dev:link-github" },
      });
    }
    return { ok: true, githubUserId: github.id, githubLogin: github.login, audited: memberships.length } as const;
  });
};
