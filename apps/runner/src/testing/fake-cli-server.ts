import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CLI_PATH_PREFIX,
  cliDeviceRequestSchema,
  cliDeviceTokenRequestSchema,
  cliDeviceResponseSchema,
  cliDeviceTokenResponseSchema,
  cliSessionMessages,
  cliTaskBranchesResponseSchema,
} from "@ostra/protocol";
import type { CliDeviceRequest, CliTaskBranchesResponse } from "@ostra/protocol";

// The web app's CLI endpoints (ticket 39's routes), built from the protocol's schemas for the CLI's
// own tests: the device grant, a task's branches, and the session's revoke. Every answer is parsed
// with the schema the real routes answer with, so the CLI reads exactly what they send.

export type FakeCliServer = {
  readonly url: string;
  /** The tasks the server knows, by every ref that names them. */
  readonly tasks: Map<string, CliTaskBranchesResponse>;
  /** Each device request's body, in order. */
  readonly deviceRequests: CliDeviceRequest[];
  /** How the next grant ends: approved after `pendingPolls` polls, or denied. */
  grant: { readonly outcome: "approve" | "deny"; readonly pendingPolls: number };
  /** Live session tokens, and the ones revoked. */
  readonly sessions: Map<string, "live" | "revoked">;
  /** Each request's method and path, in order. */
  readonly requests: string[];
  readonly revokeAll: () => void;
  readonly close: () => Promise<void>;
};

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : JSON.parse(text);
};

const send = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

export const startFakeCliServer = async (): Promise<FakeCliServer> => {
  const tasks = new Map<string, CliTaskBranchesResponse>();
  const deviceRequests: CliDeviceRequest[] = [];
  const sessions = new Map<string, "live" | "revoked">();
  const requests: string[] = [];
  const polls = new Map<string, number>();
  let url = "";
  let sessionCount = 0;

  const refused = (response: ServerResponse, authorization: string | undefined): string | undefined => {
    const token = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
    const state = token === undefined ? undefined : sessions.get(token);
    if (token === undefined || state === undefined) {
      send(response, 401, { error: { code: "session-missing", message: cliSessionMessages["session-missing"] } });
      return undefined;
    }
    if (state === "revoked") {
      send(response, 401, { error: { code: "session-revoked", message: cliSessionMessages["session-revoked"] } });
      return undefined;
    }
    return token;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    requests.push(`${request.method ?? "?"} ${path}`);
    if (request.method === "POST" && path === `${CLI_PATH_PREFIX}/device`) {
      deviceRequests.push(cliDeviceRequestSchema.parse(await readJson(request)));
      const deviceCode = randomBytes(24).toString("hex");
      polls.set(deviceCode, 0);
      send(
        response,
        200,
        cliDeviceResponseSchema.parse({
          deviceCode,
          userCode: "WDJB-MJHT",
          verificationUrl: `${url}/device`,
          verificationUrlComplete: `${url}/device?user_code=WDJB-MJHT`,
          expiresAt: Date.now() + 600_000,
          intervalSeconds: 1,
        }),
      );
      return;
    }
    if (request.method === "POST" && path === `${CLI_PATH_PREFIX}/device/token`) {
      const { deviceCode } = cliDeviceTokenRequestSchema.parse(await readJson(request));
      const count = polls.get(deviceCode);
      if (count === undefined) {
        send(response, 400, { error: { code: "expired-token", message: "That code isn't known." } });
        return;
      }
      polls.set(deviceCode, count + 1);
      if (count < server.grant.pendingPolls) {
        send(response, 400, { error: { code: "authorization-pending", message: "Not approved yet." } });
        return;
      }
      polls.delete(deviceCode);
      if (server.grant.outcome === "deny") {
        send(response, 400, { error: { code: "access-denied", message: "Denied." } });
        return;
      }
      sessionCount += 1;
      const token = `ostra_cli_${randomBytes(32).toString("base64url")}`;
      sessions.set(token, "live");
      send(response, 200, cliDeviceTokenResponseSchema.parse({ sessionId: `cli-session-${String(sessionCount)}`, token, expiresAt: Date.now() + 86_400_000, username: "demo" }));
      return;
    }
    const branches = new RegExp(`^${CLI_PATH_PREFIX}/tasks/([^/]+)/branches$`).exec(path);
    if (request.method === "GET" && branches !== null) {
      if (refused(response, request.headers.authorization) === undefined) {
        return;
      }
      const task = tasks.get(decodeURIComponent(branches[1] ?? ""));
      if (task === undefined) {
        send(response, 404, { error: { code: "not-found", message: "No such task, or you can't open it." } });
        return;
      }
      send(response, 200, cliTaskBranchesResponseSchema.parse(task));
      return;
    }
    if (request.method === "DELETE" && path === `${CLI_PATH_PREFIX}/session`) {
      const token = refused(response, request.headers.authorization);
      if (token === undefined) {
        return;
      }
      sessions.set(token, "revoked");
      send(response, 200, { revoked: true });
      return;
    }
    send(response, 404, { error: { code: "not-found", message: "No such route." } });
  };

  const http = createServer((request, response) => {
    handle(request, response).catch(() => {
      send(response, 400, { error: { code: "bad-request", message: "The request didn't parse." } });
    });
  });
  await new Promise<void>((resolve) => {
    http.listen(0, "127.0.0.1", resolve);
  });
  const address: AddressInfo | string | null = http.address();
  if (address === null || typeof address === "string") {
    throw new Error("the fake CLI server has no port");
  }
  url = `http://127.0.0.1:${String(address.port)}`;
  const server: FakeCliServer = {
    url,
    tasks,
    deviceRequests,
    grant: { outcome: "approve", pendingPolls: 1 },
    sessions,
    requests,
    revokeAll: () => {
      for (const token of sessions.keys()) {
        sessions.set(token, "revoked");
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => {
          resolve();
        });
      }),
  };
  return server;
};
