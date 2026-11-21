import type { Server } from "node:net";
import {
  cliHttpErrorSchema,
  cliPaths,
  cliPreviewTunnelRefusalWords,
  cliPreviewTunnelResponseSchema,
  cliSessionMessages,
  cliStartAppRefusalWords,
  cliStartAppResponseSchema,
  cliTunnelCloseReasonOf,
  cliTunnelCloseWords,
  cliTunnelErrorWords,
} from "@ostra/protocol";
import type { CliPreviewTunnelGrant, CliPreviewTunnelRefusal, CliTunnelErrorCode } from "@ostra/protocol";
import { z } from "zod";
import { makeAgents } from "../connection/http-carrier.ts";
import { cliRequest } from "./cli-http.ts";
import { cliSessionPath, loadCliSession } from "./cli-session.ts";
import type { CliSessionFile } from "./cli-session.ts";
import type { CliCommandDeps, CliOutcome } from "./login.ts";
import { createLocalCarrier, listenOnLoopback, openCliTunnel } from "./preview-client.ts";
import type { CliTunnel, CliTunnelFailure, LocalCarrier } from "./preview-client.ts";
import type { Ask } from "./terminal.ts";

// `ostra preview <task> [port] [--local <port>]` (milestone 8, ticket 24, F-143, ADR 0068
// "`ostra preview`"): one of a task's previews on the member's own `http://localhost:<port>`.
//
// 1. The CLI session asks the web app for a ticket (`POST /api/cli/v1/tasks/:ref/previews/tunnel`):
//    single use, 60 s, for the primary's port unless one is named, with core's address. With no box
//    running, it offers "Start the app" (`POST …/app/start`) and waits for the box.
// 2. It listens on `127.0.0.1` only, on the preview's port when that's free here, else the next.
// 3. It opens core's tunnel with the ticket and carries each local connection as one `CONNECT`.
// 4. It ends on Ctrl+C. A tunnel that drops is opened again with a new ticket, up to three times,
//    and it says so; one that ends because the CLI session ended (4401) or the view closed (4410)
//    isn't: a new ticket wouldn't help.
//
// The ticket and the session's token are never printed or logged.

export type PreviewDeps = CliCommandDeps & {
  /** Asks the person a question and reads their answer. Unset, nobody is asked, and nothing starts. */
  readonly ask?: Ask;
  /** How long "Start the app" waits for the task's box, by the clock *(working value)*. */
  readonly startWaitMs?: number;
};

/** How many times a dropped tunnel is opened again with a new ticket (ticket 24). */
export const PREVIEW_RECONNECT_TRIES = 3;
/** A tunnel up this long before it drops gets its three tries afresh. */
const STABLE_MS = 30_000;
/** How long "Start the app" waits for the task's box by default *(working value)*: a box may build its snapshot first. */
const START_WAIT_MS = 10 * 60_000;
/** How often the ticket is asked for again while the started app's box comes up. */
const START_POLL_MS = 2_000;
/** The box waits up to its ready check's 120 s for an app that's getting ready: the first probe waits a little longer. */
const READY_WAIT_MS = 150_000;
/** Said once the app takes longer than this to answer. */
const READY_SAY_AFTER_MS = 1_500;
/** The same refusal of a local connection is said again at most this often. */
const REFUSAL_SAY_EVERY_MS = 10_000;

const PREFIX = "ostra preview:";

const sleepFor = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    const done = (): void => {
      timers.forEach(clearTimeout);
      signal.removeEventListener("abort", done);
      resolve();
    };
    timers.push(setTimeout(done, ms));
    signal.addEventListener("abort", done, { once: true });
  });

/** A port named on the command line, or `null` when it isn't one. */
const portArg = (word: string): number | null => (/^\d{1,5}$/.test(word) && Number(word) >= 1 && Number(word) <= 65_535 ? Number(word) : null);

/** The web app's answer to the ticket route: the protocol's grant or refusal, or the CLI's error body (401, 400). */
const ticketAnswerSchema = z.union([cliPreviewTunnelResponseSchema, cliHttpErrorSchema]);

type Ticket =
  | { readonly kind: "grant"; readonly grant: CliPreviewTunnelGrant }
  | { readonly kind: "refused"; readonly refusal: CliPreviewTunnelRefusal }
  /** A refusal of the session or the request: final, in the server's words. */
  | { readonly kind: "failed"; readonly words: string }
  /** No answer the CLI can read: another try may get one. */
  | { readonly kind: "unreachable"; readonly words: string };

type Context = {
  readonly session: CliSessionFile;
  readonly ref: string;
  readonly deps: PreviewDeps;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now: () => number;
};

const requestSignal = (signal: AbortSignal): AbortSignal => AbortSignal.any([signal, AbortSignal.timeout(30_000)]);

/** Whether Ctrl+C came, read through a function: it comes between awaits, which the type checker doesn't see. */
const stopped = (signal: AbortSignal): boolean => signal.aborted;

const askTicket = async (context: Context, port: number | null): Promise<Ticket> => {
  const { session, ref, deps } = context;
  const answered = await cliRequest(
    { serverUrl: session.serverUrl, path: cliPaths.previewTunnel(ref), method: "POST", token: session.token, body: { port }, signal: requestSignal(deps.signal) },
    ticketAnswerSchema,
    [200, 403, 404, 409],
  );
  if (!answered.ok) {
    // A 401 carries the server's own words ("This CLI session was revoked. Run `ostra login` again.").
    return answered.kind === "refused" && answered.status !== 502 && answered.status !== 503 && answered.status !== 504
      ? { kind: "failed", words: answered.message }
      : { kind: "unreachable", words: answered.message };
  }
  const value = answered.value;
  if ("error" in value) {
    return value.error.code === "not-found"
      ? { kind: "failed", words: `this server doesn't know \`ostra preview\`: it's older than this CLI (${value.error.message})` }
      : { kind: "failed", words: value.error.message };
  }
  return "ticket" in value ? { kind: "grant", grant: value } : { kind: "refused", refusal: value };
};

const ticketWords = (ticket: Exclude<Ticket, { readonly kind: "grant" }>, port: number | null): string =>
  ticket.kind === "refused" ? cliPreviewTunnelRefusalWords(ticket.refusal, port) : ticket.words;

/** "Start the app" (ADR 0068, Q300): asks first, starts it, and waits for its box. A ticket once it's up, or why not. */
const offerStart = async (context: Context, port: number | null): Promise<Ticket | { readonly kind: "declined" } | { readonly kind: "stopped" }> => {
  const { deps } = context;
  const answer = deps.ask === undefined ? null : await deps.ask("This task's box isn't running. Start the app? [y/N] ", deps.signal);
  if (deps.signal.aborted) {
    return { kind: "stopped" };
  }
  if (answer === null || !/^\s*y(es)?\s*$/i.test(answer)) {
    return { kind: "declined" };
  }
  const started = await cliRequest(
    { serverUrl: context.session.serverUrl, path: cliPaths.startApp(context.ref), method: "POST", token: context.session.token, body: {}, signal: requestSignal(deps.signal) },
    cliStartAppResponseSchema,
    [200, 404, 409, 503],
  );
  if (!started.ok) {
    return { kind: "failed", words: started.message };
  }
  if ("code" in started.value) {
    return { kind: "failed", words: cliStartAppRefusalWords(started.value) };
  }
  deps.terminal.say(started.value.state === "running" ? "The app is running. Opening its preview..." : "Starting the app. Waiting for its box...");
  const deadline = context.now() + (deps.startWaitMs ?? START_WAIT_MS);
  for (;;) {
    const ticket = await askTicket(context, port);
    if (stopped(deps.signal)) {
      return { kind: "stopped" };
    }
    const waiting = (ticket.kind === "refused" && ticket.refusal.code === "no-box") || ticket.kind === "unreachable";
    if (!waiting) {
      return ticket;
    }
    if (context.now() >= deadline) {
      return { kind: "failed", words: "the app's box didn't come up in time. Check the task in the panel, then run this again." };
    }
    await context.sleep(START_POLL_MS, deps.signal);
  }
};

const tunnelFailureWords = (failure: CliTunnelFailure, coreUrl: string): string => {
  const host = new URL(coreUrl).host;
  switch (failure.kind) {
    case "refused":
      return cliTunnelErrorWords(failure.code);
    case "not-ostra":
      return `${host} answered ${String(failure.status)}, which isn't the ostra server's tunnel. A proxy may be in the way, or the server's core address (OSTRA_CORE_PUBLIC_URL) is wrong.`;
    case "unreachable":
      return `couldn't reach the server's core at ${host} (${failure.detail}).`;
    default:
      return failure satisfies never;
  }
};

/** Refusals of the tunnel's upgrade that a new ticket can't change. */
const finalTunnelRefusals: ReadonlySet<CliTunnelErrorCode> = new Set(["bad-request", "not-found", "port-not-allowed", "runner-cannot-tunnel", "no-box"]);

/** Why a tunnel that ended is opened again, in words, or `null` when it isn't. */
const dropWords = (code: number): string => {
  const reason = cliTunnelCloseReasonOf(code);
  if (reason !== null) {
    return cliTunnelCloseWords(reason);
  }
  return code === 1001 ? "The server is restarting." : "The connection to the server dropped.";
};

type Opened = { readonly ok: true; readonly tunnel: CliTunnel } | { readonly ok: false; readonly words: string; readonly final: boolean };

/** A new ticket for the same port, and core's tunnel with it. */
const reopen = async (context: Context, port: number): Promise<Opened> => {
  const ticket = await askTicket(context, port);
  if (ticket.kind !== "grant") {
    return { ok: false, words: ticketWords(ticket, port), final: ticket.kind !== "unreachable" };
  }
  return openWith(context, ticket.grant);
};

const openWith = async (context: Context, grant: CliPreviewTunnelGrant): Promise<Opened> => {
  const agents = makeAgents(grant.coreUrl, { proxyEnv: context.deps.env });
  const opened = await openCliTunnel({ coreUrl: grant.coreUrl, ticket: grant.ticket, agent: agents.websocket });
  if (opened.ok) {
    void opened.tunnel.ended.then(() => {
      agents.destroy();
    });
    return { ok: true, tunnel: opened.tunnel };
  }
  agents.destroy();
  const final = opened.failure.kind === "refused" && finalTunnelRefusals.has(opened.failure.code);
  return { ok: false, words: tunnelFailureWords(opened.failure, grant.coreUrl), final };
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });

/** Resolves when the signal aborts. */
const abortedOf = (signal: AbortSignal): Promise<"aborted"> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve("aborted");
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        resolve("aborted");
      },
      { once: true },
    );
  });

/** Waits for the app to answer on the box (the first `CONNECT`'s status), saying so when it takes a while. */
const waitForApp = async (carrier: LocalCarrier, grant: CliPreviewTunnelGrant, context: Context): Promise<number | null> => {
  const probed = carrier.probe(READY_WAIT_MS);
  const slow = setTimeout(() => {
    context.deps.terminal.say(`Waiting for ${grant.label} to answer on the task's port ${String(grant.port)}...`);
  }, READY_SAY_AFTER_MS);
  slow.unref();
  const status = await Promise.race([probed, abortedOf(context.deps.signal).then(() => null)]);
  clearTimeout(slow);
  return status;
};

export const runPreview = async (
  ref: string | undefined,
  portWord: string | undefined,
  flags: Readonly<Record<string, string>>,
  deps: PreviewDeps,
): Promise<CliOutcome> => {
  const { terminal } = deps;
  if (ref === undefined || ref.trim() === "") {
    terminal.warn(`${PREFIX} name the task: \`ostra preview <ticket key, task ID or URL> [port] [--local <port>]\`.`);
    return { ok: false, usage: true };
  }
  const asked = portWord === undefined ? null : portArg(portWord);
  if (portWord !== undefined && asked === null) {
    terminal.warn(`${PREFIX} "${portWord}" isn't a port: name one of the task's previews by its port, such as 5173.`);
    return { ok: false, usage: true };
  }
  const localFlag = flags["local"];
  const local = localFlag === undefined ? null : portArg(localFlag);
  if (localFlag !== undefined && local === null) {
    terminal.warn(`${PREFIX} --local "${localFlag}" isn't a port this machine can listen on.`);
    return { ok: false, usage: true };
  }
  const loaded = await loadCliSession(cliSessionPath(deps.env, deps.platform));
  if (loaded.kind !== "found") {
    terminal.warn(loaded.kind === "broken" ? `${PREFIX} ${loaded.message}. Run \`ostra login\` again.` : cliSessionMessages["session-missing"]);
    return { ok: false };
  }
  const context: Context = { session: loaded.session, ref: ref.trim(), deps, sleep: deps.sleep ?? sleepFor, now: deps.now ?? Date.now };

  // 1. The ticket, and "Start the app" when nothing runs.
  let ticket: Awaited<ReturnType<typeof offerStart>> = await askTicket(context, asked);
  if (stopped(deps.signal)) {
    return { ok: true };
  }
  if (ticket.kind === "refused" && ticket.refusal.code === "no-box") {
    ticket = await offerStart(context, asked);
  }
  switch (ticket.kind) {
    case "grant":
      break;
    case "stopped":
      return { ok: true };
    case "declined":
      terminal.warn(`${PREFIX} ${cliPreviewTunnelRefusalWords({ code: "no-box" }, asked)}`);
      return { ok: false };
    case "refused":
    case "failed":
    case "unreachable":
      terminal.warn(`${PREFIX} ${ticketWords(ticket, asked)}`);
      return { ok: false };
    default:
      return ticket satisfies never;
  }
  const grant = ticket.grant;

  // 2. The local port, before the ticket is spent: `--local`'s, or the preview's when it's free.
  const lastSaid = new Map<number, number>();
  const refused = (status: number): void => {
    const at = context.now();
    if ((lastSaid.get(status) ?? -Infinity) + REFUSAL_SAY_EVERY_MS > at) {
      return;
    }
    lastSaid.set(status, at);
    terminal.warn(
      status === 403
        ? `${PREFIX} the box refused a connection: ${cliPreviewTunnelRefusalWords({ code: "port-not-allowed" }, grant.port)}.`
        : `${PREFIX} ${grant.label} didn't answer on the task's port ${String(grant.port)} (${String(status)}). Is it running?`,
    );
  };
  const carrier = createLocalCarrier(grant.port, refused, terminal.logger);
  const listening = await listenOnLoopback(local ?? grant.port, local !== null, carrier.take);
  if (!listening.ok) {
    terminal.warn(
      listening.code === "EADDRINUSE"
        ? `${PREFIX} port ${String(listening.port)} is in use on this machine. Pick another with --local <port>.`
        : `${PREFIX} can't listen on port ${String(listening.port)} of this machine (${listening.code}). Pick another with --local <port>.`,
    );
    return { ok: false };
  }
  const { server } = listening;
  const address = `http://localhost:${String(listening.port)}`;
  terminal.logger.info("cli.preview-listening", { address: listening.host, port: listening.port, remotePort: grant.port });

  const shutdown = async (tunnel: CliTunnel | null): Promise<void> => {
    carrier.closeAll();
    tunnel?.close();
    await closeServer(server);
  };

  // 3. The tunnel.
  const first = await openWith(context, grant);
  if (!first.ok) {
    terminal.warn(`${PREFIX} ${first.words}`);
    await shutdown(null);
    return { ok: false };
  }
  let tunnel = first.tunnel;
  carrier.attach(tunnel.session);
  const ready = await waitForApp(carrier, grant, context);
  if (deps.signal.aborted) {
    await shutdown(tunnel);
    terminal.say("Stopped.");
    return { ok: true };
  }
  if (ready === 403) {
    terminal.warn(`${PREFIX} ${cliTunnelErrorWords("port-not-allowed")}`);
    await shutdown(tunnel);
    return { ok: false };
  }
  if (ready !== 200) {
    terminal.warn(`${PREFIX} ${grant.label} isn't answering on the task's port ${String(grant.port)} yet. The address works once it does.`);
  }
  if (local === null && listening.port !== grant.port) {
    terminal.say(`Port ${String(grant.port)} is taken on this machine, so the preview is on ${String(listening.port)}.`);
  }
  terminal.say(`${grant.label} (the task's port ${String(grant.port)}) is on ${address}`);
  terminal.say("Press Ctrl+C to stop.");

  // 4. Until Ctrl+C, opening a dropped tunnel again.
  const aborted = abortedOf(deps.signal);
  let upSince = context.now();
  let tries = 0;
  for (;;) {
    const ended = await Promise.race([tunnel.ended, aborted]);
    if (ended === "aborted") {
      await shutdown(tunnel);
      terminal.say("Stopped.");
      return { ok: true };
    }
    carrier.detach();
    const reason = cliTunnelCloseReasonOf(ended);
    terminal.logger.info("cli.preview-tunnel-ended", { code: ended, reason: reason ?? "dropped" });
    if (reason === "session-ended" || reason === "view-closed") {
      terminal.warn(`${PREFIX} ${cliTunnelCloseWords(reason)}`);
      await shutdown(null);
      return { ok: false };
    }
    if (context.now() - upSince >= STABLE_MS) {
      tries = 0;
    }
    terminal.say(dropWords(ended));
    let reopened: CliTunnel | null = null;
    let lastWords = "";
    while (tries < PREVIEW_RECONNECT_TRIES) {
      tries += 1;
      terminal.say(`Reconnecting with a new ticket (${String(tries)} of ${String(PREVIEW_RECONNECT_TRIES)})...`);
      await context.sleep(1_000 * 2 ** (tries - 1), deps.signal);
      if (stopped(deps.signal)) {
        await shutdown(null);
        terminal.say("Stopped.");
        return { ok: true };
      }
      const again = await reopen(context, grant.port);
      if (again.ok) {
        reopened = again.tunnel;
        break;
      }
      lastWords = again.words;
      terminal.warn(`${PREFIX} ${again.words}`);
      if (again.final) {
        await shutdown(null);
        return { ok: false };
      }
    }
    if (reopened === null) {
      terminal.warn(`${PREFIX} couldn't reconnect after ${String(PREVIEW_RECONNECT_TRIES)} tries${lastWords === "" ? "." : `: ${lastWords}`}`);
      await shutdown(null);
      return { ok: false };
    }
    tunnel = reopened;
    carrier.attach(tunnel.session);
    upSince = context.now();
    terminal.say(`Reconnected: ${grant.label} is on ${address} again.`);
  }
};
