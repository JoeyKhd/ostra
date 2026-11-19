import { z } from "zod";

// GitHub's answers, as far as ostra reads them. GitHub owns these formats, so every object
// tolerates unknown fields (AGENTS.md, Code).

const permissionLevels = z.record(z.string(), z.string());

export const appSchema = z.looseObject({
  id: z.number().int(),
  slug: z.string().min(1),
  name: z.string(),
  permissions: permissionLevels.default({}),
  events: z.array(z.string()).default([]),
  client_id: z.string().min(1).optional(),
  // Milestone 4 (F-136): the account that owns the App; GitHub's schema lets it be null.
  owner: z.looseObject({ login: z.string().min(1), id: z.number().int() }).nullish(),
});

/** `POST /app-manifests/{code}/conversions`. */
export const conversionSchema = z.looseObject({
  id: z.number().int(),
  slug: z.string().min(1),
  name: z.string(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  webhook_secret: z.string().nullish(),
  pem: z.string().min(1),
});

export const installationSchema = z.looseObject({
  id: z.number().int(),
  account: z
    .looseObject({ login: z.string().optional(), id: z.number().int().optional(), type: z.string().optional() })
    .nullish(),
  repository_selection: z.enum(["all", "selected"]),
});

export const repoSchema = z.looseObject({
  id: z.number().int(),
  full_name: z.string().min(1),
  default_branch: z.string().min(1),
  private: z.boolean(),
  clone_url: z.string().min(1),
});

export const branchSchema = z.looseObject({ default_branch: z.string().min(1) });

export const contentFileSchema = z.looseObject({
  type: z.literal("file"),
  encoding: z.string().optional(),
  content: z.string().optional(),
});

export const treeSchema = z.looseObject({
  tree: z.array(z.looseObject({ path: z.string(), type: z.string() })),
  truncated: z.boolean().optional(),
});

export const userSchema = z.looseObject({ id: z.number().int(), login: z.string() });

export const pullRequestSchema = z.looseObject({
  draft: z.boolean().optional(),
  number: z.number().int().positive(),
  html_url: z.string().min(1),
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullish(),
  title: z.string(),
  head: z.looseObject({ ref: z.string() }),
  base: z.looseObject({ ref: z.string() }),
});
export const pullRequestListSchema = z.array(pullRequestSchema);

// ---------- milestone 2 ----------

/** `GET /repos/{o}/{r}/branches/{b}`: only whether the branch is protected is read. */
export const branchProtectionSchema = z.looseObject({ protected: z.boolean() });

/** `GET /repos/{o}/{r}/rules/branches/{b}`: the rules of every ruleset that applies to the branch. */
export const branchRulesSchema = z.array(z.looseObject({ type: z.string() }));

/** `GET /repos/{o}/{r}/pulls/{n}`. */
export const pullRequestDetailsSchema = z.looseObject({
  number: z.number().int().positive(),
  html_url: z.string().min(1),
  state: z.enum(["open", "closed"]),
  merged: z.boolean().optional(),
  merged_at: z.string().nullish(),
  closed_at: z.string().nullish(),
  updated_at: z.string().min(1),
  title: z.string(),
  head: z.looseObject({ ref: z.string(), sha: z.string().min(1) }),
  base: z.looseObject({ ref: z.string() }),
  /** Milestone 3 (F-054): the description as it is now, and whether it is a draft. */
  body: z.string().nullish(),
  draft: z.boolean().optional(),
});

/** A `pull_request` webhook's payload. */
export const pullRequestWebhookSchema = z.looseObject({
  action: z.string().min(1),
  number: z.number().int().positive(),
  installation: z.looseObject({ id: z.number().int() }).nullish(),
  repository: z.looseObject({ id: z.number().int(), full_name: z.string().min(1) }),
  pull_request: pullRequestDetailsSchema,
});

// ---------- milestone 3 (ADR 0051, ADR 0052) ----------

/** `GET /repos/{o}/{r}/compare/{base}...{head}`: the counts, the merge base and the files (on the first page only). */
export const compareSchema = z.looseObject({
  ahead_by: z.number().int().nonnegative(),
  behind_by: z.number().int().nonnegative(),
  merge_base_commit: z.looseObject({ sha: z.string().min(1) }).nullish(),
  files: z
    .array(
      z.looseObject({
        filename: z.string().min(1),
        previous_filename: z.string().nullish(),
        status: z.string(),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
        changes: z.number().int().nonnegative().optional(),
        patch: z.string().nullish(),
      }),
    )
    .optional(),
});

/** A PR as the draft switch reads it: its GraphQL node ID and whether it's a draft. */
export const pullRequestNodeSchema = pullRequestSchema.extend({ node_id: z.string().min(1) });

/** GraphQL's answer to the draft mutations: errors come with 200. */
export const graphqlAnswerSchema = z.looseObject({
  data: z.unknown().optional(),
  errors: z.array(z.looseObject({ message: z.string().optional(), type: z.string().optional() })).nullish(),
});

const commentUserSchema = z.looseObject({ id: z.number().int(), login: z.string().min(1) });
const webhookRepositorySchema = z.looseObject({ id: z.number().int(), full_name: z.string().min(1) });
const webhookInstallationSchema = z.looseObject({ id: z.number().int() }).nullish();

/** An `issue_comment` webhook: a comment on an issue, or on a PR's conversation when `issue.pull_request` is there. */
export const issueCommentWebhookSchema = z.looseObject({
  action: z.string().min(1),
  installation: webhookInstallationSchema,
  repository: webhookRepositorySchema,
  issue: z.looseObject({ number: z.number().int().positive(), pull_request: z.looseObject({}).nullish() }),
  comment: z.looseObject({ id: z.number().int(), body: z.string().nullish(), html_url: z.string().min(1), user: commentUserSchema }),
});

/** A `pull_request_review_comment` webhook: a comment on a line (or a file) of a PR's diff. */
export const reviewCommentWebhookSchema = z.looseObject({
  action: z.string().min(1),
  installation: webhookInstallationSchema,
  repository: webhookRepositorySchema,
  pull_request: z.looseObject({ number: z.number().int().positive() }),
  comment: z.looseObject({
    id: z.number().int(),
    body: z.string().nullish(),
    html_url: z.string().min(1),
    user: commentUserSchema,
    path: z.string().min(1),
    line: z.number().int().nullish(),
    original_line: z.number().int().nullish(),
    side: z.string().nullish(),
    subject_type: z.string().nullish(),
  }),
});

/** A `push` webhook. Each commit lists the paths it added, removed and changed. */
export const pushWebhookSchema = z.looseObject({
  ref: z.string().min(1),
  before: z.string().min(1),
  after: z.string().min(1),
  installation: webhookInstallationSchema,
  repository: webhookRepositorySchema,
  commits: z
    .array(
      z.looseObject({
        added: z.array(z.string()).optional(),
        removed: z.array(z.string()).optional(),
        modified: z.array(z.string()).optional(),
      }),
    )
    .nullish(),
});

/** `POST https://github.com/login/oauth/access_token` with `Accept: application/json`: a token, or an error with 200. */
export const userTokenSchema = z
  .looseObject({ access_token: z.string().min(1).optional(), error: z.string().min(1).optional() })
  .refine((answer) => answer.access_token !== undefined || answer.error !== undefined, "neither a token nor an error");

// ---------- milestone 4 (F-104, ADR 0040) ----------

/** A review's author: `type` is `Bot` for an App's bot (`<slug>[bot]`), `User` for a person. */
const reviewUserSchema = z.looseObject({ id: z.number().int(), login: z.string().min(1), type: z.string().optional() });

/**
 * One review, as `GET /repos/{o}/{r}/pulls/{n}/reviews` lists it and the `pull_request_review`
 * webhook carries it. The REST API writes the state in capitals (`APPROVED`), the webhook in small
 * letters (`approved`); a pending review has no `submitted_at`. The body is never read. A deleted
 * account's review has `user: null`.
 */
export const reviewSchema = z.looseObject({
  id: z.number().int(),
  user: reviewUserSchema.nullish(),
  state: z.string().min(1),
  commit_id: z.string().nullish(),
  submitted_at: z.string().nullish(),
});
export const reviewListSchema = z.array(reviewSchema);
export type GitHubReview = z.infer<typeof reviewSchema>;

/** A `pull_request_review` webhook: a review submitted, edited or dismissed, with the PR's head. */
export const reviewWebhookSchema = z.looseObject({
  action: z.string().min(1),
  installation: webhookInstallationSchema,
  repository: webhookRepositorySchema,
  pull_request: z.looseObject({ number: z.number().int().positive(), head: z.looseObject({ sha: z.string().min(1) }) }),
  review: reviewSchema,
});

/** A check run, as the Checks API answers one. */
export const checkRunSchema = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  head_sha: z.string().min(1),
  status: z.string(),
  conclusion: z.string().nullish(),
  app: z.looseObject({ id: z.number().int() }).nullish(),
});

/** `GET /repos/{o}/{r}/commits/{ref}/check-runs`. */
export const checkRunListSchema = z.looseObject({ total_count: z.number().int().nonnegative(), check_runs: z.array(checkRunSchema) });

// ---------- milestone 4 (ticket 47, F-136, ADR 0065): the installation webhooks ----------

/** The account an installation is on: `type` is `Organization` or `User`. */
const installationAccountSchema = z.looseObject({ id: z.number().int(), login: z.string().min(1), type: z.string().optional() });

/** A repo as the installation webhooks name it. */
const installationRepoSchema = z.looseObject({ id: z.number().int(), full_name: z.string().min(1) });

/**
 * An `installation` webhook: the App installed on an account (`created`), uninstalled (`deleted`),
 * `suspend`ed, `unsuspend`ed, or its new permissions accepted. Every App gets it; no subscription.
 */
export const installationWebhookSchema = z.looseObject({
  action: z.string().min(1),
  installation: z.looseObject({ id: z.number().int(), account: installationAccountSchema }),
});

/** An `installation_repositories` webhook: repos `added` to an installation or `removed` from it. */
export const installationRepositoriesWebhookSchema = z.looseObject({
  action: z.string().min(1),
  installation: z.looseObject({ id: z.number().int(), account: installationAccountSchema }),
  repositories_added: z.array(installationRepoSchema).default([]),
  repositories_removed: z.array(installationRepoSchema).default([]),
});
