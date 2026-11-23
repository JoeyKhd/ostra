import { z } from "zod";

// Jira Cloud's REST v3 answers, as far as the adapter reads them (research/trackers.md §2). Jira
// owns the format, so every object tolerates fields it doesn't name (AGENTS.md), and the inferred
// types are trusted after the boundary. IDs Jira sends as numbers in some places are read as strings.

const id = z.union([z.string().min(1), z.number().int()]).transform(String);

export const statusCategorySchema = z.looseObject({ key: z.string(), name: z.string().optional() });

export const statusSchema = z.looseObject({
  id,
  name: z.string(),
  statusCategory: statusCategorySchema.optional(),
});
export type JiraStatusJson = z.infer<typeof statusSchema>;

export const accountSchema = z.looseObject({
  accountId: z.string().min(1),
  displayName: z.string().optional(),
  emailAddress: z.string().optional(),
  accountType: z.string().optional(),
  active: z.boolean().optional(),
  timeZone: z.string().optional(),
});
export type JiraAccount = z.infer<typeof accountSchema>;

export const issueRefSchema = z.looseObject({
  id,
  key: z.string(),
  fields: z
    .looseObject({
      summary: z.string().optional(),
      status: statusSchema.optional(),
    })
    .optional(),
});
export type JiraIssueRef = z.infer<typeof issueRefSchema>;

export const attachmentSchema = z.looseObject({
  id,
  filename: z.string(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  author: z.looseObject({ accountId: z.string() }).nullish(),
});
export type JiraAttachment = z.infer<typeof attachmentSchema>;

export const issueLinkSchema = z.looseObject({
  id: id.optional(),
  type: z.looseObject({ name: z.string(), inward: z.string().optional(), outward: z.string().optional() }),
  inwardIssue: issueRefSchema.optional(),
  outwardIssue: issueRefSchema.optional(),
});
export type JiraIssueLink = z.infer<typeof issueLinkSchema>;

export const issueSchema = z.looseObject({
  id,
  key: z.string(),
  fields: z.looseObject({
    summary: z.string(),
    description: z.unknown().optional(),
    status: statusSchema,
    priority: z.looseObject({ id: id.optional(), name: z.string().optional() }).nullish(),
    parent: issueRefSchema.nullish(),
    labels: z.array(z.string()).optional(),
    assignee: accountSchema.nullish(),
    project: z.looseObject({ id, key: z.string().optional(), name: z.string().optional() }),
    updated: z.string(),
    issuetype: z.looseObject({ id, name: z.string().optional(), subtask: z.boolean().optional(), hierarchyLevel: z.number().optional() }).optional(),
    subtasks: z.array(issueRefSchema).optional(),
    issuelinks: z.array(issueLinkSchema).optional(),
    attachment: z.array(attachmentSchema).optional(),
  }),
});
export type JiraIssue = z.infer<typeof issueSchema>;

/** A search for an issue's children, which asks only for their summary and status. */
export const childrenPageSchema = z.looseObject({ issues: z.array(issueRefSchema) });

export const searchPageSchema = z.looseObject({
  issues: z.array(issueSchema),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().optional(),
});

export const commentSchema = z.looseObject({
  id,
  body: z.unknown().optional(),
  author: accountSchema.nullish(),
  updateAuthor: accountSchema.nullish(),
  created: z.string(),
  updated: z.string().optional(),
});
export type JiraComment = z.infer<typeof commentSchema>;

export const commentPageSchema = z.looseObject({
  comments: z.array(commentSchema),
  startAt: z.number().optional(),
  maxResults: z.number().optional(),
  total: z.number().optional(),
});

export const remoteLinkSchema = z.looseObject({
  id,
  globalId: z.string().optional(),
  object: z.looseObject({ url: z.string(), title: z.string().optional(), summary: z.string().nullish() }),
});
export const remoteLinksSchema = z.array(remoteLinkSchema);

export const createdSchema = z.looseObject({ id, key: z.string().optional() });

export const projectSchema = z.looseObject({
  id,
  key: z.string(),
  name: z.string(),
  style: z.string().optional(),
  issueTypes: z
    .array(z.looseObject({ id, name: z.string(), subtask: z.boolean().optional(), hierarchyLevel: z.number().optional() }))
    .optional(),
});
export type JiraProject = z.infer<typeof projectSchema>;

export const projectPageSchema = z.looseObject({
  values: z.array(projectSchema),
  isLast: z.boolean().optional(),
  startAt: z.number().optional(),
  total: z.number().optional(),
});

/** `GET /project/{id}/statuses`: each issue type with its statuses. */
export const projectStatusesSchema = z.array(
  z.looseObject({ id, name: z.string(), subtask: z.boolean().optional(), statuses: z.array(statusSchema) }),
);

export const transitionsSchema = z.looseObject({
  transitions: z.array(
    z.looseObject({
      id,
      name: z.string(),
      to: statusSchema,
      isAvailable: z.boolean().optional(),
      isGlobal: z.boolean().optional(),
    }),
  ),
});
export type JiraIssueTransition = z.infer<typeof transitionsSchema>["transitions"][number];

export const myPermissionsSchema = z.looseObject({
  permissions: z.record(z.string(), z.looseObject({ havePermission: z.boolean() })),
});

// The workflows API (`/rest/api/3/workflows/search`, `POST /rest/api/3/workflows`), which replaced
// the classic `workflow/search` (removed 2026-06-01, Atlassian's changelog CHANGE-2569). A workflow
// names its statuses by a reference; the answer's own status list maps each to its ID and category
// (`TODO`, `IN_PROGRESS`, `DONE`).

export const workflowStatusSchema = z.looseObject({
  id,
  name: z.string(),
  statusCategory: z.string().optional(),
  statusReference: z.string().min(1),
});
export type JiraWorkflowStatusJson = z.infer<typeof workflowStatusSchema>;

export const workflowSchema = z.looseObject({
  name: z.string(),
  statuses: z.array(z.looseObject({ statusReference: z.string().min(1) })).optional(),
  transitions: z
    .array(
      z.looseObject({
        id,
        name: z.string(),
        /** `INITIAL`, `GLOBAL` (from any status) or `DIRECTED` (from its links' statuses). */
        type: z.string().optional(),
        toStatusReference: z.string().optional(),
        links: z.array(z.looseObject({ fromStatusReference: z.string().optional() })).optional(),
      }),
    )
    .optional(),
});
export type JiraWorkflowJson = z.infer<typeof workflowSchema>;

/** `GET /workflows/search`: a page of workflows, with the statuses they reference. */
export const workflowSearchSchema = z.looseObject({
  values: z.array(workflowSchema),
  statuses: z.array(workflowStatusSchema).optional(),
  isLast: z.boolean().optional(),
});

/** `POST /workflows`: the workflows of the projects and issue types asked for, with their statuses. */
export const workflowReadSchema = z.looseObject({
  workflows: z.array(workflowSchema),
  statuses: z.array(workflowStatusSchema).optional(),
});

export const usersSchema = z.array(accountSchema);

export const tenantInfoSchema = z.looseObject({ cloudId: z.string().min(1) });

/** `GET /rest/api/2/serverInfo`, which answers without a credential: Cloud, or Jira Server or Data Center. */
export const serverInfoSchema = z.looseObject({ deploymentType: z.string().optional() });

export const propertySchema = z.looseObject({ key: z.string().optional(), value: z.unknown() });

/**
 * ostra's own issue property: which attachment carries which of `attachFile`'s markers. ostra owns
 * the format, so a field it doesn't know is refused, and the property reads as holding none.
 */
export const markersPropertySchema = z.strictObject({ markers: z.record(z.string(), z.string().max(500)) });
export type MarkersProperty = z.infer<typeof markersPropertySchema>;
