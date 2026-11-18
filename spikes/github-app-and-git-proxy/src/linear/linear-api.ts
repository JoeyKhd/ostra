import { z } from 'zod';

// The few Linear GraphQL calls the link probe needs, over fetch. A vendor
// format: unknown fields are tolerated. The key is sent, never logged. The
// endpoint comes from LINEAR_API_URL (default https://api.linear.app/graphql).

export type LinearClient = { readonly apiKey: string; readonly url: string };

const call = async <T,>(client: LinearClient, query: string, variables: Record<string, string>, schema: z.ZodType<T>): Promise<T> => {
  const res = await fetch(client.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: client.apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const json: unknown = await res.json();
  const envelope = z
    .object({ data: z.unknown().optional(), errors: z.array(z.object({ message: z.string() }).loose()).optional() })
    .loose()
    .parse(json);
  if (!res.ok || (envelope.errors !== undefined && envelope.errors.length > 0)) throw new Error(`Linear API error (status ${String(res.status)})`);
  return schema.parse(envelope.data);
};

const IssueSchema = z.object({ id: z.string(), identifier: z.string().regex(/^[A-Z0-9]+-\d+$/), url: z.url() }).loose();
export type LinearIssue = z.infer<typeof IssueSchema>;

export const createIssue = async (client: LinearClient, teamId: string, title: string): Promise<LinearIssue> => {
  const data = await call(
    client,
    'mutation($teamId: String!, $title: String!) { issueCreate(input: { teamId: $teamId, title: $title }) { success issue { id identifier url } } }',
    { teamId, title },
    z.object({ issueCreate: z.object({ success: z.boolean(), issue: IssueSchema }).loose() }).loose(),
  );
  return data.issueCreate.issue;
};

export const issueAttachmentUrls = async (client: LinearClient, id: string): Promise<string[]> => {
  const data = await call(
    client,
    'query($id: String!) { issue(id: $id) { attachments { nodes { url sourceType } } } }',
    { id },
    z
      .object({
        issue: z.object({ attachments: z.object({ nodes: z.array(z.object({ url: z.string() }).loose()) }).loose() }).loose(),
      })
      .loose(),
  );
  return data.issue.attachments.nodes.map((x) => x.url);
};

export const archiveIssue = async (client: LinearClient, id: string): Promise<void> => {
  await call(client, 'mutation($id: String!) { issueArchive(id: $id) { success } }', { id }, z.unknown());
};
