import { AgentActivitySignal, LinearClient, LinearError } from "@linear/sdk";
import { LinearWebhookClient } from "@linear/sdk/webhooks";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import { createServer } from "node:http";
import { z } from "zod";

// The same as ../baseline, plus a realistic use of @linear/sdk: the client, an agent-activity mutation, a model
// query with a relation, the typed webhook payload and the signature verifier.

const configSchema = z.object({ port: z.number().int().positive(), publicUrl: z.url() });
export type Config = z.infer<typeof configSchema>;

export const start = (raw: unknown): Config => {
  const config = configSchema.parse(raw);
  createServer((_req, res) => {
    res.end("ok");
  }).listen(config.port);
  return config;
};

export const react = async (accessToken: string, sessionId: string, issueId: string): Promise<string> => {
  const client = new LinearClient({ accessToken });
  try {
    const payload = await client.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: "response", body: "done" },
      signal: AgentActivitySignal.Continue,
    });
    const issue = await client.issue(issueId);
    const team = await issue.team;
    return `${payload.agentActivityId ?? "none"} ${issue.identifier} ${team?.key ?? "none"}`;
  } catch (error: unknown) {
    if (error instanceof LinearError) return error.message;
    throw error;
  }
};

export const verify = (secret: string, body: Buffer, signature: string): string => {
  const client = new LinearWebhookClient(secret);
  return client.parseData(body, signature).type;
};

export const describeEvent = (event: AgentSessionEventWebhookPayload): string =>
  `${event.action} ${event.agentSession.id} ${event.agentSession.issue?.identifier ?? "none"}`;
