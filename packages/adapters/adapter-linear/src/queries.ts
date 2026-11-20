import { z } from "zod";

// Every GraphQL document the adapter sends, and the schemas its answers are read with. Each asks
// only for the fields the adapter reads, and keeps its worst-case complexity under Linear's 10,000
// points per query (linear.app/developers/rate-limiting): `complexity.test.ts` scores each one with
// the largest variables the adapter sends. Linear owns these formats, so every schema is loose.

/** The largest page `listTickets` asks for (spec, ticket 07). */
export const MAX_TICKET_PAGE = 250;
/** Labels read per issue: enough for any real ticket, and small enough for a page of 250. */
export const LABELS_PER_ISSUE = 20;
/** Comments read per page of a ticket's context. */
export const COMMENTS_PER_PAGE = 100;
/** Pages of comments read at most: a ticket with more is read up to there. */
export const MAX_COMMENT_PAGES = 10;
/** Emails asked for in one `users` query (F-036): a delivery's audience is a handful. */
export const USERS_PER_QUERY = 50;
/** A session's activities read per page, looking for ostra's before posting (milestone 6). */
export const ACTIVITIES_PER_PAGE = 250;
/** Pages of a session's activities read at most: past that, the client-made ID still dedupes. */
export const MAX_ACTIVITY_PAGES = 8;

// ---------- fields ----------

const STATE_FIELDS = "state { id name type }";

/** A ticket, as `Ticket` needs it. */
export const ISSUE_FIELDS = `id identifier title description url priority updatedAt ${STATE_FIELDS} team { id } parent { id identifier } assignee { id name } labels(first: ${String(LABELS_PER_ISSUE)}) { nodes { name } }`;

/** Another ticket, as `TicketSummary` needs it. */
const SUMMARY_FIELDS = `id identifier title url ${STATE_FIELDS}`;

const COMMENT_FIELDS = "id body createdAt updatedAt user { id name } parent { id }";

const PAGE_INFO = "pageInfo { hasNextPage endCursor }";

// ---------- documents ----------

export const documents = {
  viewer: "query OstraViewer { viewer { id } }",
  teams: `query OstraTeams($after: String) { teams(first: 250, after: $after) { nodes { id key name } ${PAGE_INFO} } }`,
  teamStates: "query OstraTeamStates($id: String!) { team(id: $id) { id states(first: 100) { nodes { id name type position } } } }",
  issue: `query OstraIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
  issuesByUpdatedAt: `query OstraIssuesByUpdatedAt($filter: IssueFilter, $after: String, $first: Int) { issues(filter: $filter, after: $after, first: $first, sort: [{ updatedAt: { order: Ascending } }]) { nodes { ${ISSUE_FIELDS} } ${PAGE_INFO} } }`,
  issues: `query OstraIssues($filter: IssueFilter, $after: String, $first: Int) { issues(filter: $filter, after: $after, first: $first, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } ${PAGE_INFO} } }`,
  issueContext: `query OstraIssueContext($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} comments(first: ${String(COMMENTS_PER_PAGE)}) { nodes { ${COMMENT_FIELDS} } ${PAGE_INFO} } attachments(first: 50) { nodes { id url title subtitle } } parent { ${SUMMARY_FIELDS} } children(first: 50) { nodes { ${SUMMARY_FIELDS} } } relations(first: 50) { nodes { type relatedIssue { ${SUMMARY_FIELDS} } } } inverseRelations(first: 50) { nodes { type issue { ${SUMMARY_FIELDS} } } } } }`,
  issueComments: `query OstraIssueComments($id: String!, $after: String) { issue(id: $id) { id comments(first: ${String(COMMENTS_PER_PAGE)}, after: $after) { nodes { ${COMMENT_FIELDS} } ${PAGE_INFO} } } }`,
  commentOwner: "query OstraCommentOwner($id: String!) { comment(id: $id) { id issue { id } } }",
  integrations: "query OstraIntegrations($after: String) { integrations(first: 100, after: $after) { nodes { id service } pageInfo { hasNextPage endCursor } } }",
  issueUpdateState: `mutation OstraIssueUpdateState($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id ${STATE_FIELDS} } } }`,
  commentCreate: "mutation OstraCommentCreate($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } } }",
  commentUpdate: "mutation OstraCommentUpdate($id: String!, $body: String!) { commentUpdate(id: $id, input: { body: $body }) { success comment { id } } }",
  attachmentCreate:
    "mutation OstraAttachmentCreate($issueId: String!, $url: String!, $title: String!, $subtitle: String) { attachmentCreate(input: { issueId: $issueId, url: $url, title: $title, subtitle: $subtitle }) { success attachment { id } } }",
  // An issue's links, to find a PR's before linking it: Linear refuses a second link of one URL.
  issueAttachments: "query OstraIssueAttachments($id: String!) { issue(id: $id) { id attachments(first: 100) { nodes { id url } } } }",
  attachmentLinkGitHubPR: "mutation OstraLinkPullRequest($issueId: String!, $url: String!) { attachmentLinkGitHubPR(issueId: $issueId, url: $url) { success } }",
  attachmentLinkGitHubPRWithKind:
    "mutation OstraLinkPullRequestWithKind($issueId: String!, $url: String!, $linkKind: GitLinkKind!) { attachmentLinkGitHubPR(issueId: $issueId, url: $url, linkKind: $linkKind) { success } }",
  // Active users only: Linear leaves out deactivated ones by default (`includeDisabled: false`),
  // and the filter says so too.
  usersByEmail: `query OstraUsersByEmail($emails: [String!]!, $first: Int) { users(first: $first, filter: { email: { in: $emails }, active: { eq: true } }) { nodes { id name displayName email url active } } }`,
  issueCreate: `mutation OstraIssueCreate($teamId: String!, $title: String!, $description: String) { issueCreate(input: { teamId: $teamId, title: $title, description: $description }) { success issue { ${ISSUE_FIELDS} } } }`,
  // ---------- milestone 6 (ticket 07) ----------
  // A sub-issue: `parentId` on the same team (F-077, F-099).
  issueCreateChild: `mutation OstraIssueCreateChild($teamId: String!, $title: String!, $description: String, $parentId: String!) { issueCreate(input: { teamId: $teamId, title: $title, description: $description, parentId: $parentId }) { success issue { ${ISSUE_FIELDS} } } }`,
  // A draft's description, written by "Update ticket" (F-099).
  issueUpdateDescription: "mutation OstraIssueUpdateDescription($id: String!, $description: String!) { issueUpdate(id: $id, input: { description: $description }) { success issue { id } } }",
  // Linear's upload: a signed URL to PUT the bytes to, then the asset URL is attached.
  fileUpload:
    "mutation OstraFileUpload($contentType: String!, $filename: String!, $size: Int!) { fileUpload(contentType: $contentType, filename: $filename, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }",
  // A person, for matching a session's creator to a member (ADR 0057). Without `email` when the
  // token can't read it.
  user: "query OstraUser($id: String!) { user(id: $id) { id name email active } }",
  userWithoutEmail: "query OstraUserWithoutEmail($id: String!) { user(id: $id) { id name active } }",
  // A session's activities, to find ostra's by its client-made ID before posting (F-046).
  agentSessionActivities: `query OstraAgentSessionActivities($id: String!, $after: String) { agentSession(id: $id) { id activities(first: ${String(ACTIVITIES_PER_PAGE)}, after: $after) { nodes { id } ${PAGE_INFO} } } }`,
  agentActivityCreate: "mutation OstraAgentActivityCreate($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success agentActivity { id } } }",
  agentSessionUpdateUrls: "mutation OstraAgentSessionUpdateUrls($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }",
} as const;

export type DocumentName = keyof typeof documents;

/** The largest variables the adapter sends with each document, for the complexity test. */
export const worstCaseVariables: Readonly<Record<DocumentName, Readonly<Record<string, unknown>>>> = {
  viewer: {},
  teams: {},
  teamStates: {},
  issue: {},
  issuesByUpdatedAt: { first: MAX_TICKET_PAGE },
  issues: { first: MAX_TICKET_PAGE },
  issueContext: {},
  issueComments: {},
  commentOwner: {},
  integrations: {},
  issueUpdateState: {},
  commentCreate: {},
  commentUpdate: {},
  attachmentCreate: {},
  issueAttachments: {},
  attachmentLinkGitHubPR: {},
  attachmentLinkGitHubPRWithKind: {},
  usersByEmail: { first: USERS_PER_QUERY * 2 },
  issueCreate: {},
  issueCreateChild: {},
  issueUpdateDescription: {},
  fileUpload: {},
  user: {},
  userWithoutEmail: {},
  agentSessionActivities: {},
  agentActivityCreate: {},
  agentSessionUpdateUrls: {},
};

// ---------- what Linear answers, read loosely ----------

const nodes = <S extends z.ZodType>(schema: S) => z.looseObject({ nodes: z.array(schema) });
const pageInfoSchema = z.looseObject({ hasNextPage: z.boolean(), endCursor: z.string().nullish() });

export const stateSchema = z.looseObject({ id: z.string(), name: z.string(), type: z.string() });

export const issueSchema = z.looseObject({
  id: z.string(),
  identifier: z.string().min(1),
  title: z.string(),
  description: z.string().nullish(),
  url: z.string(),
  priority: z.number().nullish(),
  updatedAt: z.string(),
  state: stateSchema,
  // Read loosely: an answer without the team still parses, and is then on no board.
  team: z.looseObject({ id: z.string() }).nullish(),
  parent: z.looseObject({ id: z.string(), identifier: z.string() }).nullish(),
  assignee: z.looseObject({ id: z.string(), name: z.string() }).nullish(),
  labels: nodes(z.looseObject({ name: z.string() })).nullish(),
});
export type LinearIssue = z.infer<typeof issueSchema>;

export const summarySchema = z.looseObject({ id: z.string(), identifier: z.string(), title: z.string(), url: z.string(), state: stateSchema });
export type LinearSummary = z.infer<typeof summarySchema>;

export const commentSchema = z.looseObject({
  id: z.string(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  user: z.looseObject({ id: z.string(), name: z.string() }).nullish(),
  parent: z.looseObject({ id: z.string() }).nullish(),
});
export type LinearComment = z.infer<typeof commentSchema>;

const commentsPageSchema = z.looseObject({ nodes: z.array(commentSchema), pageInfo: pageInfoSchema });

export const answers = {
  viewer: z.looseObject({ viewer: z.looseObject({ id: z.string() }) }),
  teams: z.looseObject({
    teams: z.looseObject({ nodes: z.array(z.looseObject({ id: z.string(), key: z.string(), name: z.string() })), pageInfo: pageInfoSchema }),
  }),
  teamStates: z.looseObject({
    team: z.looseObject({
      id: z.string(),
      states: nodes(z.looseObject({ id: z.string(), name: z.string(), type: z.string(), position: z.number() })),
    }),
  }),
  issue: z.looseObject({ issue: issueSchema }),
  issues: z.looseObject({ issues: z.looseObject({ nodes: z.array(issueSchema), pageInfo: pageInfoSchema }) }),
  issueContext: z.looseObject({
    issue: issueSchema.extend({
      comments: commentsPageSchema,
      attachments: nodes(z.looseObject({ id: z.string(), url: z.string(), title: z.string(), subtitle: z.string().nullish() })),
      parent: summarySchema.nullish(),
      children: nodes(summarySchema),
      relations: nodes(z.looseObject({ type: z.string(), relatedIssue: summarySchema.nullish() })),
      inverseRelations: nodes(z.looseObject({ type: z.string(), issue: summarySchema.nullish() })),
    }),
  }),
  issueComments: z.looseObject({ issue: z.looseObject({ id: z.string(), comments: commentsPageSchema }) }),
  commentOwner: z.looseObject({
    comment: z.looseObject({
      id: z.string(),
      issue: z.looseObject({ id: z.string() }).nullish(),
    }),
  }),
  integrations: z.looseObject({
    integrations: z.looseObject({ nodes: z.array(z.looseObject({ id: z.string(), service: z.string() })), pageInfo: pageInfoSchema }),
  }),
  issueUpdateState: z.looseObject({
    issueUpdate: z.looseObject({ success: z.boolean(), issue: z.looseObject({ id: z.string(), state: stateSchema }).nullish() }),
  }),
  commentCreate: z.looseObject({ commentCreate: z.looseObject({ success: z.boolean(), comment: z.looseObject({ id: z.string() }).nullish() }) }),
  commentUpdate: z.looseObject({ commentUpdate: z.looseObject({ success: z.boolean(), comment: z.looseObject({ id: z.string() }).nullish() }) }),
  attachmentCreate: z.looseObject({
    attachmentCreate: z.looseObject({ success: z.boolean(), attachment: z.looseObject({ id: z.string() }).nullish() }),
  }),
  issueAttachments: z.looseObject({ issue: z.looseObject({ id: z.string(), attachments: nodes(z.looseObject({ id: z.string(), url: z.string() })) }) }),
  attachmentLinkGitHubPR: z.looseObject({ attachmentLinkGitHubPR: z.looseObject({ success: z.boolean() }) }),
  usersByEmail: z.looseObject({
    users: nodes(
      z.looseObject({
        id: z.string(),
        name: z.string(),
        displayName: z.string(),
        email: z.string(),
        url: z.string(),
        active: z.boolean().nullish(),
      }),
    ),
  }),
  issueCreate: z.looseObject({ issueCreate: z.looseObject({ success: z.boolean(), issue: issueSchema.nullish() }) }),
  issueUpdateDescription: z.looseObject({ issueUpdate: z.looseObject({ success: z.boolean() }) }),
  fileUpload: z.looseObject({
    fileUpload: z.looseObject({
      success: z.boolean(),
      uploadFile: z
        .looseObject({
          uploadUrl: z.string(),
          assetUrl: z.string(),
          headers: z.array(z.looseObject({ key: z.string(), value: z.string() })).nullish(),
        })
        .nullish(),
    }),
  }),
  user: z.looseObject({
    user: z.looseObject({ id: z.string(), name: z.string(), email: z.string().nullish(), active: z.boolean().nullish() }),
  }),
  agentSessionActivities: z.looseObject({
    agentSession: z.looseObject({ id: z.string(), activities: z.looseObject({ nodes: z.array(z.looseObject({ id: z.string() })), pageInfo: pageInfoSchema }) }),
  }),
  agentActivityCreate: z.looseObject({
    agentActivityCreate: z.looseObject({ success: z.boolean(), agentActivity: z.looseObject({ id: z.string() }).nullish() }),
  }),
  agentSessionUpdate: z.looseObject({ agentSessionUpdate: z.looseObject({ success: z.boolean() }) }),
} as const;
