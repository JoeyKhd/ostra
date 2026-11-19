import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { Server, Socket } from "node:net";
import { TLSSocket } from "node:tls";

import { z } from "zod";

import { makeSelfSignedCert } from "./self-signed-cert.ts";
import type { SelfSignedCert } from "./self-signed-cert.ts";

// The email sinks of the notification suites (milestone 3, ticket 04; spec section 8, Q186): a
// fake of Resend's API (`POST /emails`, its `Idempotency-Key`, a 429 with `Retry-After`) and a fake
// SMTP server on `node:net` (`EHLO`, `STARTTLS` accepted or refused, `AUTH PLAIN` and `LOGIN`,
// `MAIL`, `RCPT` with a 4xx or a 5xx for named recipients, `DATA`). Each keeps what it received for
// the test to read. No network beyond loopback, and no new dependency. Test-only.

// ---------- Resend ----------

/** One email the fake Resend API accepted, as its body carried it. */
export type ResendReceived = {
  readonly id: string;
  readonly idempotencyKey: string | null;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly html: string | null;
  readonly text: string | null;
  readonly headers: Readonly<Record<string, string>>;
};

export type FakeResendApi = {
  /** The API's base URL, such as `http://127.0.0.1:51234`. */
  readonly url: string;
  readonly apiKey: string;
  readonly received: readonly ResendReceived[];
  /** The next call answers 429 with this `Retry-After`. */
  readonly rateLimitNext: (retryAfterSeconds: number) => void;
  /** Addresses Resend refuses with 422, as an invalid recipient. */
  readonly refuse: Set<string>;
  /** How many calls reached it, accepted or not. */
  readonly calls: () => number;
  /** Milestone 3 (ticket 12): the domains `GET /domains` lists. Edit it to make one unverified. */
  readonly domains: { name: string; status: ResendDomainStatus }[];
  /** The key is a sending-only one: `GET /domains` answers 401 `restricted_api_key`, as Resend does. */
  restrictedKey: boolean;
  /** With it on, `POST /emails` answers 403 for a `from` on a domain that isn't verified (`resend.dev` always sends). */
  enforceDomains: boolean;
  /** The next call, whatever it is, answers this status and error name (an outage, a refused key). */
  readonly failNext: (status: number, name: string) => void;
  readonly close: () => Promise<void>;
};

export type ResendDomainStatus = "not_started" | "pending" | "verified" | "failed" | "partially_verified" | "partially_failed";

// Resend's request body, read as a strict client would send it.
const resendBodySchema = z.looseObject({
  from: z.string().min(1),
  to: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  subject: z.string(),
  html: z.string().optional(),
  text: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

/** The port a server listens on, once it does. */
const portOf = (server: { readonly address: () => unknown }): number => {
  const address = server.address();
  const port: unknown = typeof address === "object" && address !== null ? Reflect.get(address, "port") : undefined;
  if (typeof port !== "number") {
    throw new Error("the fake server isn't listening");
  }
  return port;
};

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });

const sendJson = (response: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
};

const resendError = (response: ServerResponse, status: number, name: string, message: string, headers: Readonly<Record<string, string>> = {}): void => {
  sendJson(response, status, { statusCode: status, name, message }, headers);
};

/** Starts the fake Resend API on loopback. */
export const startFakeResendApi = async (options: { readonly apiKey?: string; readonly domains?: readonly string[] } = {}): Promise<FakeResendApi> => {
  const apiKey = options.apiKey ?? `re_fake_${randomUUID().replaceAll("-", "")}`;
  const received: ResendReceived[] = [];
  const byKey = new Map<string, { readonly body: string; readonly id: string }>();
  const refuse = new Set<string>();
  let rateLimit: number | null = null;
  let calls = 0;
  let fault: { readonly status: number; readonly name: string } | null = null;
  const domains: { name: string; status: ResendDomainStatus }[] = (options.domains ?? ["example.com"]).map((name) => ({ name, status: "verified" }));
  const controls = { restrictedKey: false, enforceDomains: false };
  const stored = new Map<string, ResendReceived>();
  const server = createHttpServer((request, response) => {
    void (async () => {
      calls += 1;
      const body = await readBody(request);
      const isGet = request.method === "GET";
      const isSend = request.method === "POST" && request.url === "/emails";
      const lookup = isGet ? /^\/emails\/([^/?]+)$/.exec(request.url ?? "") : null;
      if (!isSend && !(isGet && (request.url === "/domains" || lookup !== null))) {
        resendError(response, 404, "not_found", "The requested endpoint does not exist.");
        return;
      }
      if (request.headers.authorization !== `Bearer ${apiKey}`) {
        resendError(response, 401, "missing_api_key", "API key is invalid");
        return;
      }
      if (fault !== null) {
        const { status, name } = fault;
        fault = null;
        resendError(response, status, name, "The fake was told to fail this call.");
        return;
      }
      if (request.url === "/domains") {
        if (controls.restrictedKey) {
          resendError(response, 401, "restricted_api_key", "This API key is restricted to only send emails");
          return;
        }
        sendJson(response, 200, {
          object: "list",
          has_more: false,
          data: domains.map((domain, index) => ({ id: `domain-${String(index)}`, name: domain.name, status: domain.status, created_at: "2026-11-19T00:00:00.000Z", region: "us-east-1" })),
        });
        return;
      }
      if (lookup !== null) {
        const found = stored.get(lookup[1] ?? "");
        if (found === undefined) {
          resendError(response, 404, "not_found", "Email not found.");
          return;
        }
        sendJson(response, 200, { object: "email", id: found.id, from: found.from, to: found.to, subject: found.subject, html: found.html, text: found.text, last_event: "delivered" });
        return;
      }
      if (rateLimit !== null) {
        const retryAfter = rateLimit;
        rateLimit = null;
        resendError(response, 429, "rate_limit_exceeded", "Too many requests.", { "retry-after": String(retryAfter) });
        return;
      }
      const keyHeader = request.headers["idempotency-key"];
      const idempotencyKey = typeof keyHeader === "string" ? keyHeader : null;
      if (idempotencyKey !== null) {
        const seen = byKey.get(idempotencyKey);
        if (seen !== undefined) {
          if (seen.body !== body) {
            resendError(response, 409, "invalid_idempotent_request", "The key was used with a different body.");
            return;
          }
          sendJson(response, 200, { id: seen.id });
          return;
        }
      }
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        resendError(response, 422, "validation_error", "The body is not JSON.");
        return;
      }
      const parsed = resendBodySchema.safeParse(json);
      if (!parsed.success) {
        resendError(response, 422, "validation_error", "The body is not an email.");
        return;
      }
      const fromDomain = /@([^>\s]+)>?\s*$/.exec(parsed.data.from)?.[1]?.toLowerCase();
      if (controls.enforceDomains && fromDomain !== "resend.dev" && !domains.some((domain) => domain.status === "verified" && domain.name === fromDomain)) {
        resendError(response, 403, "validation_error", `The ${fromDomain ?? "from"} domain is not verified.`);
        return;
      }
      const to = typeof parsed.data.to === "string" ? [parsed.data.to] : parsed.data.to;
      const refused = to.find((address) => refuse.has(address));
      if (refused !== undefined) {
        resendError(response, 422, "validation_error", "Invalid `to` field.");
        return;
      }
      const id = randomUUID();
      if (idempotencyKey !== null) {
        byKey.set(idempotencyKey, { body, id });
      }
      const mail: ResendReceived = {
        id,
        idempotencyKey,
        from: parsed.data.from,
        to,
        subject: parsed.data.subject,
        html: parsed.data.html ?? null,
        text: parsed.data.text ?? null,
        headers: parsed.data.headers ?? {},
      };
      received.push(mail);
      stored.set(id, mail);
      sendJson(response, 200, { id });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = portOf(server);
  return {
    url: `http://127.0.0.1:${String(port)}`,
    apiKey,
    received,
    rateLimitNext: (retryAfterSeconds) => {
      rateLimit = retryAfterSeconds;
    },
    refuse,
    calls: () => calls,
    domains,
    get restrictedKey() {
      return controls.restrictedKey;
    },
    set restrictedKey(value: boolean) {
      controls.restrictedKey = value;
    },
    get enforceDomains() {
      return controls.enforceDomains;
    },
    set enforceDomains(value: boolean) {
      controls.enforceDomains = value;
    },
    failNext: (status, name) => {
      fault = { status, name };
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};

// ---------- SMTP ----------

/** One message the fake SMTP server took, with the envelope and the raw DATA (dot-unstuffed). */
export type SmtpReceived = {
  readonly from: string;
  readonly to: readonly string[];
  readonly data: string;
  /** Whether the session ran over TLS by the time of DATA. */
  readonly tls: boolean;
  /** The user `AUTH` signed in as, or `null`. */
  readonly user: string | null;
};

export type FakeSmtpOptions = {
  /** `offered`: STARTTLS is offered and accepted. `refused`: offered, then refused with 454. `none`: not offered. */
  readonly starttls?: "offered" | "refused" | "none";
  /** The one user and password `AUTH` takes; `null` takes no `AUTH`. */
  readonly auth?: { readonly user: string; readonly pass: string } | null;
  /** Refuse `MAIL` and `RCPT` until the session is on TLS. */
  readonly requireTls?: boolean;
  /** Recipients answered with this reply line, such as `450 4.2.1 Mailbox busy` or `550 5.1.1 No such user`. */
  readonly rejectRecipients?: Readonly<Record<string, string>>;
};

export type FakeSmtpServer = {
  readonly host: string;
  readonly port: number;
  /** The server's certificate, for a client that checks it (`ca`). */
  readonly cert: string;
  readonly received: readonly SmtpReceived[];
  /** Every command line the server read, with `AUTH` payloads replaced by `***`. */
  readonly commands: readonly string[];
  readonly close: () => Promise<void>;
};

const plainCredentials = (encoded: string): { readonly user: string; readonly pass: string } | null => {
  const parts = Buffer.from(encoded, "base64").toString("utf8").split("\u0000");
  const [, user, pass] = parts;
  return parts.length === 3 && user !== undefined && pass !== undefined ? { user, pass } : null;
};

const decode64 = (text: string): string => Buffer.from(text, "base64").toString("utf8");

const addressOf = (argument: string): string => {
  const match = /<([^>]*)>/.exec(argument);
  return (match?.[1] ?? argument.trim()).trim();
};

/** Starts the fake SMTP server on loopback. */
export const startFakeSmtpServer = async (options: FakeSmtpOptions = {}): Promise<FakeSmtpServer> => {
  const tlsMaterial: SelfSignedCert = await makeSelfSignedCert();
  const starttls = options.starttls ?? "offered";
  const received: SmtpReceived[] = [];
  const commands: string[] = [];
  const sockets = new Set<Socket>();

  const serve = (raw: Socket): void => {
    sockets.add(raw);
    raw.on("close", () => sockets.delete(raw));
    let socket: Socket = raw;
    let buffer = "";
    let secure = false;
    let user: string | null = null;
    let from: string | null = null;
    let to: string[] = [];
    let mode: "command" | "data" | "auth-plain" | "auth-login-user" | "auth-login-pass" = "command";
    let loginUser = "";
    let data: string[] = [];

    const reply = (line: string): void => {
      socket.write(`${line}\r\n`);
    };
    const reset = (): void => {
      from = null;
      to = [];
      data = [];
    };
    const ehlo = (): void => {
      const lines = ["250-localhost greets you", "250-8BITMIME"];
      if (!secure && starttls !== "none") {
        lines.push("250-STARTTLS");
      }
      if (options.auth !== null && options.auth !== undefined) {
        lines.push("250-AUTH PLAIN LOGIN");
      }
      lines.push("250 SMTPUTF8");
      socket.write(`${lines.join("\r\n")}\r\n`);
    };
    const signIn = (credentials: { readonly user: string; readonly pass: string } | null): void => {
      const expected = options.auth ?? null;
      if (credentials !== null && expected !== null && credentials.user === expected.user && credentials.pass === expected.pass) {
        user = credentials.user;
        reply("235 2.7.0 Authentication successful");
      } else {
        reply("535 5.7.8 Authentication credentials invalid");
      }
    };

    const onLine = (line: string): void => {
      if (mode === "data") {
        if (line === ".") {
          mode = "command";
          received.push({ from: from ?? "", to: [...to], data: data.join("\r\n"), tls: secure, user });
          reset();
          reply(`250 2.0.0 Ok: queued as ${randomUUID()}`);
          return;
        }
        data.push(line.startsWith("..") ? line.slice(1) : line);
        return;
      }
      if (mode === "auth-plain") {
        commands.push("***");
        mode = "command";
        signIn(plainCredentials(line));
        return;
      }
      if (mode === "auth-login-user") {
        commands.push("***");
        loginUser = decode64(line);
        mode = "auth-login-pass";
        reply("334 UGFzc3dvcmQ6");
        return;
      }
      if (mode === "auth-login-pass") {
        commands.push("***");
        mode = "command";
        signIn({ user: loginUser, pass: decode64(line) });
        return;
      }
      const [verb = "", ...rest] = line.split(" ");
      const upper = verb.toUpperCase();
      const argument = rest.join(" ");
      commands.push(upper === "AUTH" ? `AUTH ${rest[0] ?? ""} ***` : line);
      switch (upper) {
        case "EHLO":
        case "HELO":
          reset();
          ehlo();
          return;
        case "STARTTLS": {
          if (starttls !== "offered" || secure) {
            reply("454 4.7.0 TLS not available due to temporary reason");
            return;
          }
          reply("220 2.0.0 Ready to start TLS");
          const plain = socket;
          plain.removeAllListeners("data");
          const upgraded = new TLSSocket(plain, { isServer: true, key: tlsMaterial.key, cert: tlsMaterial.cert });
          secure = true;
          socket = upgraded;
          buffer = "";
          // A new session after TLS: the client says EHLO again (RFC 3207).
          user = null;
          reset();
          upgraded.on("data", onData);
          upgraded.on("error", () => {
            plain.destroy();
          });
          return;
        }
        case "AUTH": {
          if (options.auth === null || options.auth === undefined) {
            reply("503 5.5.1 AUTH not available");
            return;
          }
          const [method = "", initial] = rest;
          if (method.toUpperCase() === "PLAIN") {
            if (initial === undefined) {
              reply("334 ");
              mode = "auth-plain";
              return;
            }
            signIn(plainCredentials(initial));
            return;
          }
          if (method.toUpperCase() === "LOGIN") {
            mode = "auth-login-user";
            reply("334 VXNlcm5hbWU6");
            return;
          }
          reply("504 5.5.4 Unrecognized authentication type");
          return;
        }
        case "MAIL":
          if (options.requireTls === true && !secure) {
            reply("530 5.7.0 Must issue a STARTTLS command first");
            return;
          }
          if (options.auth !== null && options.auth !== undefined && user === null) {
            reply("530 5.7.0 Authentication required");
            return;
          }
          from = addressOf(argument.replace(/^FROM:/i, ""));
          reply("250 2.1.0 Ok");
          return;
        case "RCPT": {
          if (from === null) {
            reply("503 5.5.1 Bad sequence of commands");
            return;
          }
          const address = addressOf(argument.replace(/^TO:/i, ""));
          const rejection = options.rejectRecipients?.[address];
          if (rejection !== undefined) {
            reply(rejection);
            return;
          }
          to.push(address);
          reply("250 2.1.5 Ok");
          return;
        }
        case "DATA":
          if (to.length === 0) {
            reply("554 5.5.1 No valid recipients");
            return;
          }
          mode = "data";
          reply("354 End data with <CR><LF>.<CR><LF>");
          return;
        case "RSET":
          reset();
          reply("250 2.0.0 Ok");
          return;
        case "NOOP":
          reply("250 2.0.0 Ok");
          return;
        case "QUIT":
          reply("221 2.0.0 Bye");
          socket.end();
          return;
        default:
          reply("502 5.5.2 Command not recognized");
      }
    };

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      for (let index = buffer.indexOf("\r\n"); index !== -1; index = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        onLine(line);
      }
    };

    raw.on("data", onData);
    raw.on("error", () => undefined);
    reply("220 localhost ESMTP ostra-fake-smtp");
  };

  const server: Server = createNetServer(serve);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = portOf(server);
  return {
    host: "127.0.0.1",
    port,
    cert: tlsMaterial.cert,
    received,
    commands,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => {
          resolve();
        });
      }),
  };
};
