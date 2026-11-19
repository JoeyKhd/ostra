import { z } from "zod";

// The demo's own calls to Linear (spec section 3, step 3), with the maintainer's key from
// linear.env: what a person does in Linear, outside ostra, and what the checks after the run read
// back. The key goes in the Authorization header only: never a log line, never an error message.

const API_URL = "https://api.linear.app/graphql";

// A 1×1 PNG, so the ticket carries a real image for the context (F-064).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

export type LinearTool = {
  readonly call: (query: string, variables?: Record<string, unknown>) => Promise<unknown>;
};

export const linearTool = (apiKey: string, apiUrl: string = API_URL): LinearTool => ({
  call: async (query, variables = {}) => {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: apiKey },
      body: JSON.stringify({ query, variables }),
    });
    const body: unknown = await response.json().catch(() => null);
    const parsed = z.looseObject({ data: z.unknown(), errors: z.array(z.looseObject({ message: z.string().optional() })).nullish() }).safeParse(body);
    if (!response.ok || !parsed.success || (parsed.data.errors?.length ?? 0) > 0) {
      // Linear's error messages name fields and codes, never the key.
      const words = parsed.success ? (parsed.data.errors ?? []).map((error) => error.message ?? "").join("; ") : "";
      throw new Error(`Linear refused a demo call (HTTP ${String(response.status)}): ${words.slice(0, 300)}`);
    }
    return parsed.data.data;
  },
});

const workspaceSchema = z.object({
  viewer: z.object({ id: z.string(), name: z.string() }),
  organization: z.object({ id: z.string(), urlKey: z.string(), name: z.string() }),
});

export type LinearWorkspace = z.infer<typeof workspaceSchema>;

export const readWorkspace = async (tool: LinearTool): Promise<LinearWorkspace> =>
  workspaceSchema.parse(await tool.call("query { viewer { id name } organization { id urlKey name } }"));

/** Uploads the demo's image the way Linear's editor does, and answers its asset URL. */
export const uploadImage = async (tool: LinearTool, filename: string): Promise<string> => {
  const data = await tool.call(
    "mutation ($size: Int!, $filename: String!) { fileUpload(contentType: \"image/png\", filename: $filename, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }",
    { size: PNG.length, filename },
  );
  const { uploadFile } = z
    .object({ fileUpload: z.object({ uploadFile: z.object({ uploadUrl: z.string(), assetUrl: z.string(), headers: z.array(z.object({ key: z.string(), value: z.string() })) }) }) })
    .parse(data).fileUpload;
  const headers: Record<string, string> = { "content-type": "image/png", "cache-control": "public, max-age=31536000" };
  for (const header of uploadFile.headers) headers[header.key] = header.value;
  const put = await fetch(uploadFile.uploadUrl, { method: "PUT", headers, body: PNG });
  if (!put.ok) throw new Error(`the image upload failed (HTTP ${String(put.status)})`);
  return uploadFile.assetUrl;
};

const labelsSchema = z.object({ issueLabels: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string() })) }) });

/** The team's label of that name, made when it doesn't exist. */
export const ensureLabel = async (tool: LinearTool, teamId: string, name: string): Promise<string> => {
  const found = labelsSchema.parse(
    await tool.call("query ($name: String!) { issueLabels(filter: { name: { eq: $name } }, first: 10) { nodes { id name } } }", { name }),
  ).issueLabels.nodes[0];
  if (found !== undefined) return found.id;
  const made = z
    .object({ issueLabelCreate: z.object({ issueLabel: z.object({ id: z.string() }) }) })
    .parse(await tool.call("mutation ($teamId: String!, $name: String!) { issueLabelCreate(input: { teamId: $teamId, name: $name }) { issueLabel { id } } }", { teamId, name }));
  return made.issueLabelCreate.issueLabel.id;
};

export type CreatedIssue = { readonly id: string; readonly identifier: string; readonly url: string };

const createdSchema = z.object({ issueCreate: z.object({ issue: z.object({ id: z.string(), identifier: z.string(), url: z.string() }) }) });

export const createIssue = async (
  tool: LinearTool,
  input: { readonly teamId: string; readonly title: string; readonly description: string; readonly labelIds: readonly string[] },
): Promise<CreatedIssue> =>
  createdSchema.parse(
    await tool.call(
      "mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier url } } }",
      { input: { teamId: input.teamId, title: input.title, description: input.description, labelIds: input.labelIds } },
    ),
  ).issueCreate.issue;

export const addComment = async (tool: LinearTool, issueId: string, body: string): Promise<void> => {
  await tool.call("mutation ($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }", { issueId, body });
};

export const updateIssueTitle = async (tool: LinearTool, issueId: string, title: string): Promise<void> => {
  await tool.call("mutation ($id: String!, $title: String!) { issueUpdate(id: $id, input: { title: $title }) { success } }", { id: issueId, title });
};

export const archiveIssue = async (tool: LinearTool, issueId: string): Promise<void> => {
  await tool.call("mutation ($id: String!) { issueArchive(id: $id) { success } }", { id: issueId });
};

const issueStateSchema = z.object({
  issue: z.object({
    identifier: z.string(),
    state: z.object({ id: z.string(), name: z.string(), type: z.string() }),
    comments: z.object({ nodes: z.array(z.object({ id: z.string(), body: z.string(), user: z.object({ id: z.string() }).nullable() })) }),
    attachments: z.object({ nodes: z.array(z.object({ id: z.string(), url: z.string(), title: z.string().nullable() })) }),
    history: z.object({
      nodes: z.array(z.object({ id: z.string(), createdAt: z.string(), fromState: z.object({ id: z.string(), name: z.string() }).nullable(), toState: z.object({ id: z.string(), name: z.string() }).nullable() })),
    }),
  }),
});

export type IssueState = z.infer<typeof issueStateSchema>["issue"];

/** The ticket as the checks read it: its status, every comment, every attachment, and its status history. */
export const readIssue = async (tool: LinearTool, issueId: string): Promise<IssueState> =>
  issueStateSchema.parse(
    await tool.call(
      "query ($id: String!) { issue(id: $id) { identifier state { id name type } comments(first: 50) { nodes { id body user { id } } } attachments(first: 50) { nodes { id url title } } history(first: 100) { nodes { id createdAt fromState { id name } toState { id name } } } } }",
      { id: issueId },
    ),
  ).issue;

const webhookSchema = z.object({ webhookCreate: z.object({ success: z.boolean(), webhook: z.object({ id: z.string() }) }) });

/** A workspace webhook on the team (the dev seed's, spec section 3): its ID, to delete it after the run. */
export const createWebhook = async (tool: LinearTool, input: { readonly url: string; readonly teamId: string; readonly secret: string; readonly label: string }): Promise<string> =>
  webhookSchema.parse(
    await tool.call(
      "mutation ($input: WebhookCreateInput!) { webhookCreate(input: $input) { success webhook { id } } }",
      { input: { url: input.url, teamId: input.teamId, secret: input.secret, label: input.label, resourceTypes: ["Issue", "Comment", "IssueLabel", "Attachment"] } },
    ),
  ).webhookCreate.webhook.id;

export const deleteWebhook = async (tool: LinearTool, id: string): Promise<void> => {
  await tool.call("mutation ($id: String!) { webhookDelete(id: $id) { success } }", { id });
};

const webhooksSchema = z.object({ webhooks: z.object({ nodes: z.array(z.object({ id: z.string(), label: z.string().nullable(), url: z.string().nullable() })) }) });

/** The workspace's webhooks: the seed deletes those an earlier run of the demo left. */
export const listWebhooks = async (tool: LinearTool): Promise<z.infer<typeof webhooksSchema>["webhooks"]["nodes"]> =>
  webhooksSchema.parse(await tool.call("query { webhooks(first: 50) { nodes { id label url } } }")).webhooks.nodes;
