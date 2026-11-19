// `pnpm --filter @ostra/e2e-m3 fixtures` (ticket 50): the demo's two loopback servers, kept up for
// the whole run in a process of their own, so each demo step can be a short run of its own.
//
// - A mail server (adapter-sdk's in-process fake SMTP server, plain on loopback with AUTH): the
//   scripted run's mail goes here until `email.env` holds a Resend key (ticket 50's decision on
//   Q186). Each mail is appended to `mail.jsonl`, with its recipients, subject and text body.
// - The `release-names` MCP server: streamable HTTP that answers only a request carrying its bearer
//   token, with one tool, `next_release_name`. Each request is appended to `mcp.jsonl` with its
//   path, method and whether its token was right: never the token.
//
// Their addresses and the MCP server's token go into `fixtures.json` in the state folder, which
// the demo reads to fill the panel's forms. The token is a secret: never printed.

import { randomBytes } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import path from "node:path";

import { startFakeSmtpServer } from "@ostra/adapter-sdk/testing";
import { say } from "@ostra/e2e-m1/setup";
import { z } from "zod";

import { m3Settings } from "./settings.ts";

/** The one name the tool gives: the demo's checks look for it in the PR. */
export const RELEASE_NAME = "Quiet Heron";

const rpcSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.looseObject({ name: z.string().optional(), protocolVersion: z.string().optional() }).optional(),
});

const readBody = async (request: IncomingMessage): Promise<string> => {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
};

// Ported from apps/runner/src/testing/token-mcp-server.ts: the same token check, with a tool that answers a name.
const answer = (message: z.infer<typeof rpcSchema>): unknown => {
  if (message.method === "initialize") {
    return { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "release-names", version: "1.0.0" } };
  }
  if (message.method === "tools/list") {
    return { tools: [{ name: "next_release_name", description: "The name of the next release. Use it as the release name.", inputSchema: { type: "object", properties: {} } }] };
  }
  if (message.method === "tools/call") {
    return { content: [{ type: "text", text: RELEASE_NAME }] };
  }
  return {};
};

const main = async (): Promise<void> => {
  const settings = m3Settings(process.env);
  await mkdir(settings.m3StateDir, { recursive: true });
  const mailLog = path.join(settings.m3StateDir, "mail.jsonl");
  const mcpLog = path.join(settings.m3StateDir, "mcp.jsonl");
  const smtpUser = "ostra-demo";
  const smtpPass = randomBytes(18).toString("base64url");
  const token = randomBytes(24).toString("base64url");

  const smtp = await startFakeSmtpServer({ starttls: "none", auth: { user: smtpUser, pass: smtpPass } });
  let seen = 0;
  setInterval(() => {
    const fresh = smtp.received.slice(seen);
    seen = smtp.received.length;
    for (const mail of fresh) {
      const subject = /^Subject: (.*)$/m.exec(mail.data)?.[1] ?? "";
      void appendFile(mailLog, `${JSON.stringify({ at: Date.now(), from: mail.from, to: mail.to, subject, user: mail.user, data: mail.data })}\n`);
      say(`mail to ${mail.to.join(", ")}: ${subject}`);
    }
  }, 500);

  const mcp = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? "";
      const method = request.method ?? "";
      const authorized = request.headers.authorization === `Bearer ${token}`;
      const record = async (rpc: string | null) => appendFile(mcpLog, `${JSON.stringify({ at: Date.now(), path: url, method, authorized, rpc })}\n`);
      if (url !== "/mcp") {
        await record(null);
        response.writeHead(404).end();
        return;
      }
      if (!authorized) {
        await record(null);
        response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "a token is needed" }));
        return;
      }
      if (method === "GET") {
        await record(null);
        response.writeHead(405).end();
        return;
      }
      if (method !== "POST") {
        await record(null);
        response.writeHead(method === "DELETE" ? 200 : 405).end();
        return;
      }
      const parsed = rpcSchema.safeParse(JSON.parse(await readBody(request)));
      await record(parsed.success ? (parsed.data.method ?? null) : null);
      if (!parsed.success || parsed.data.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "release-names-session" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.data.id, result: answer(parsed.data) }));
    })();
  });
  await new Promise<void>((resolve) => {
    mcp.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = mcp.address();
  const mcpPort = typeof address === "object" && address !== null ? address.port : 0;
  await writeFile(
    path.join(settings.m3StateDir, "fixtures.json"),
    JSON.stringify({ pid: process.pid, smtp: { host: smtp.host, port: smtp.port, user: smtpUser, pass: smtpPass }, mcp: { url: `http://127.0.0.1:${String(mcpPort)}/mcp`, token } }, null, 2),
  );
  say(`fixtures up: mail on ${smtp.host}:${String(smtp.port)}, release-names on 127.0.0.1:${String(mcpPort)}`);
  const stop = () => {
    void smtp.close().finally(() => {
      mcp.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
};

await main();
