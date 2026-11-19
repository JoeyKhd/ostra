import { connect as connectNet } from "node:net";
import type { Socket } from "node:net";
import { connect as connectTls } from "node:tls";

import { afterEach, describe, expect, it } from "vitest";

import { startFakeResendApi, startFakeSmtpServer } from "./fake-email.ts";
import type { FakeResendApi, FakeSmtpOptions, FakeSmtpServer } from "./fake-email.ts";

// The email sinks' own error modes (ticket 04): the Resend fake's keys, idempotency, rate limit and
// refused recipient, and the SMTP fake's STARTTLS, AUTH, refusals and DATA, driven by hand.

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const resend = async (): Promise<FakeResendApi> => {
  const api = await startFakeResendApi();
  closers.push(api.close);
  return api;
};

const post = (api: FakeResendApi, body: unknown, headers: Readonly<Record<string, string>> = {}) =>
  fetch(`${api.url}/emails`, {
    method: "POST",
    headers: { authorization: `Bearer ${api.apiKey}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const email = { from: "ostra <ostra@example.com>", to: ["ada@example.com"], subject: "Approval needed", html: "<p>x</p>", text: "x" };

describe("the fake Resend API", () => {
  it("F-115: takes a send with the key, answers its ID, and keeps what it got", async () => {
    const api = await resend();
    const response = await post(api, email);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({ id: api.received[0]?.id });
    expect(api.received[0]).toMatchObject({ to: ["ada@example.com"], subject: "Approval needed", html: "<p>x</p>", text: "x" });
  });

  it("F-115: refuses a wrong key, and a refused recipient, keeping nothing", async () => {
    const api = await resend();
    expect((await post(api, email, { authorization: "Bearer wrong" })).status).toBe(401);
    api.refuse.add("ada@example.com");
    expect((await post(api, email)).status).toBe(422);
    expect(api.received).toEqual([]);
  });

  it("F-115: answers one ID per idempotency key, and refuses the key with another body", async () => {
    const api = await resend();
    const first: unknown = await (await post(api, email, { "idempotency-key": "k-1" })).json();
    const again: unknown = await (await post(api, email, { "idempotency-key": "k-1" })).json();
    expect(again).toEqual(first);
    expect(api.received).toHaveLength(1);
    expect((await post(api, { ...email, subject: "other" }, { "idempotency-key": "k-1" })).status).toBe(409);
  });

  it("F-115: answers a rate limit with Retry-After once, then takes the send", async () => {
    const api = await resend();
    api.rateLimitNext(7);
    const limited = await post(api, email);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("7");
    expect((await post(api, email)).status).toBe(200);
  });

  const get = (api: FakeResendApi, path: string, key = api.apiKey) => fetch(`${api.url}${path}`, { headers: { authorization: `Bearer ${key}` } });

  it("F-115: lists its domains with their status, answers 401 to a sending-only key, and 401 to a wrong one", async () => {
    const api = await resend();
    api.domains.push({ name: "pending.example", status: "pending" });
    const listed: unknown = await (await get(api, "/domains")).json();
    expect(listed).toMatchObject({
      object: "list",
      data: [
        { name: "example.com", status: "verified" },
        { name: "pending.example", status: "pending" },
      ],
    });
    api.restrictedKey = true;
    const restricted = await get(api, "/domains");
    expect(restricted.status).toBe(401);
    expect(await restricted.json()).toMatchObject({ name: "restricted_api_key" });
    // A sending-only key still sends.
    expect((await post(api, email)).status).toBe(200);
    expect((await get(api, "/domains", "wrong")).status).toBe(401);
  });

  it("F-115: refuses a send from a domain that isn't verified, when told to, and reads a sent email back", async () => {
    const api = await resend();
    api.enforceDomains = true;
    expect((await post(api, { ...email, from: "ostra@stranger.test" })).status).toBe(403);
    expect((await post(api, { ...email, from: "Resend <onboarding@resend.dev>" })).status).toBe(200);
    const sent = await post(api, email);
    const body: unknown = await sent.json();
    const id = api.received.at(-1)?.id ?? "";
    expect(body).toEqual({ id });
    expect(await (await get(api, `/emails/${id}`)).json()).toMatchObject({ id, to: ["ada@example.com"], subject: "Approval needed", last_event: "delivered" });
    expect((await get(api, "/emails/unknown-id")).status).toBe(404);
  });

  it("F-115: fails the next call with the status it was told to, once", async () => {
    const api = await resend();
    api.failNext(503, "application_error");
    expect((await post(api, email)).status).toBe(503);
    expect((await post(api, email)).status).toBe(200);
    // Or a later call: the second one from now.
    api.failNext(429, "rate_limit_exceeded", 1);
    expect((await post(api, email)).status).toBe(200);
    expect((await post(api, email)).status).toBe(429);
    expect((await post(api, email)).status).toBe(200);
  });
});

// ---------- a hand-driven SMTP client ----------

type Session = {
  /** Sends a line and reads the whole reply (every `250-` line up to the last `250 `). */
  readonly say: (line: string) => Promise<string>;
  readonly startTls: (cert: string) => Promise<void>;
  readonly greeting: string;
  readonly close: () => void;
};

const open = async (server: FakeSmtpServer): Promise<Session> => {
  let socket: Socket = connectNet(server.port, server.host);
  let buffer = "";
  let waiting: ((reply: string) => void) | undefined;
  const lines: string[] = [];
  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString("utf8");
    for (let index = buffer.indexOf("\r\n"); index !== -1; index = buffer.indexOf("\r\n")) {
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      const last = lines.at(-1) ?? "";
      if (/^\d{3} /.test(last) || /^\d{3}$/.test(last)) {
        const reply = lines.splice(0).join("\n");
        const resolve = waiting;
        waiting = undefined;
        resolve?.(reply);
      }
    }
  };
  const next = (): Promise<string> =>
    new Promise((resolve) => {
      waiting = resolve;
    });
  socket.on("data", onData);
  const greeting = await next();
  return {
    greeting,
    say: (line) => {
      const reply = next();
      socket.write(`${line}\r\n`);
      return reply;
    },
    startTls: (cert) =>
      new Promise((resolve, reject) => {
        socket.removeAllListeners("data");
        const secure = connectTls({ socket, servername: "localhost", ca: cert }, () => {
          resolve();
        });
        secure.on("data", onData);
        secure.on("error", reject);
        socket = secure;
      }),
    close: () => {
      socket.destroy();
    },
  };
};

const smtp = async (options: FakeSmtpOptions): Promise<FakeSmtpServer> => {
  const server = await startFakeSmtpServer(options);
  closers.push(server.close);
  return server;
};

const plain = (user: string, pass: string): string => Buffer.from(`\u0000${user}\u0000${pass}`).toString("base64");

describe("the fake SMTP server", () => {
  it("F-115: upgrades to TLS with a certificate for localhost, signs in, and takes a message", async () => {
    const server = await smtp({ starttls: "offered", auth: { user: "ostra", pass: "secret" }, requireTls: true });
    const session = await open(server);
    try {
      expect(session.greeting).toMatch(/^220 /);
      const ehlo = await session.say("EHLO client");
      expect(ehlo).toContain("STARTTLS");
      // Before TLS a message is refused, for want of TLS.
      expect(await session.say("MAIL FROM:<ostra@example.com>")).toMatch(/^530 .*STARTTLS/);
      expect(await session.say("STARTTLS")).toMatch(/^220 /);
      await session.startTls(server.cert);
      expect(await session.say("EHLO client")).not.toContain("STARTTLS");
      expect(await session.say(`AUTH PLAIN ${plain("ostra", "secret")}`)).toMatch(/^235 /);
      expect(await session.say("MAIL FROM:<ostra@example.com>")).toMatch(/^250 /);
      expect(await session.say("RCPT TO:<ada@example.com>")).toMatch(/^250 /);
      expect(await session.say("DATA")).toMatch(/^354 /);
      expect(await session.say("Subject: Approval needed\r\n\r\nLine one\r\n..dotted\r\n.")).toMatch(/^250 /);
      expect(server.received).toEqual([
        { from: "ostra@example.com", to: ["ada@example.com"], data: "Subject: Approval needed\r\n\r\nLine one\r\n.dotted", tls: true, user: "ostra" },
      ]);
      // The password never sits in what the server logged.
      expect(server.commands.join("\n")).not.toContain(plain("ostra", "secret"));
    } finally {
      session.close();
    }
  });

  it("F-115: signs in with AUTH LOGIN, and refuses a wrong password and a missing sign-in", async () => {
    const server = await smtp({ starttls: "none", auth: { user: "ostra", pass: "secret" } });
    const session = await open(server);
    try {
      await session.say("EHLO client");
      expect(await session.say("MAIL FROM:<a@example.com>")).toMatch(/^530 /);
      expect(await session.say(`AUTH PLAIN ${plain("ostra", "wrong")}`)).toMatch(/^535 /);
      expect(await session.say("AUTH LOGIN")).toMatch(/^334 /);
      expect(await session.say(Buffer.from("ostra").toString("base64"))).toMatch(/^334 /);
      expect(await session.say(Buffer.from("secret").toString("base64"))).toMatch(/^235 /);
      expect(await session.say("MAIL FROM:<a@example.com>")).toMatch(/^250 /);
    } finally {
      session.close();
    }
  });

  it("F-115: refuses STARTTLS when told to, and answers named recipients with their 4xx and 5xx", async () => {
    const server = await smtp({
      starttls: "refused",
      auth: null,
      rejectRecipients: { "busy@example.com": "450 4.2.1 Mailbox busy", "gone@example.com": "550 5.1.1 No such user" },
    });
    const session = await open(server);
    try {
      expect(await session.say("EHLO client")).toContain("STARTTLS");
      expect(await session.say("STARTTLS")).toMatch(/^454 /);
      expect(await session.say("MAIL FROM:<a@example.com>")).toMatch(/^250 /);
      expect(await session.say("RCPT TO:<busy@example.com>")).toMatch(/^450 /);
      expect(await session.say("RCPT TO:<gone@example.com>")).toMatch(/^550 /);
      expect(await session.say("DATA")).toMatch(/^554 /);
      expect(await session.say("RCPT TO:<ok@example.com>")).toMatch(/^250 /);
      expect(await session.say("DATA")).toMatch(/^354 /);
      expect(await session.say("hi\r\n.")).toMatch(/^250 /);
      expect(server.received.map((message) => message.to)).toEqual([["ok@example.com"]]);
      expect(server.received[0]?.tls).toBe(false);
    } finally {
      session.close();
    }
  });
});
