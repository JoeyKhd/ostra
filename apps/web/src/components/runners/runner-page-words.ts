import { formatAge, formatClock, formatElapsed } from "@/lib/format";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import type { FleetLine, VersionState } from "./fleet-words";
import { shortDate } from "./runner-words";

// F-092, F-061, F-013, F-091 (ticket 31, runner.md, runner-approval.md): a runner's page in the
// panel's words. Pure, so the words are tested without a browser; each switch is exhaustive.

type Page = RouterOutputs["runners"]["get"];

/** `SHA256:q7Hc…9fLm`: the first and last 4 characters of the fingerprint's hash. */
export const fingerprintShort = (fingerprint: string): string => {
  const hash = fingerprint.startsWith("SHA256:") ? fingerprint.slice(7) : fingerprint;
  return hash.length <= 8 ? `SHA256:${hash}` : `SHA256:${hash.slice(0, 4)}…${hash.slice(-4)}`;
};

/** `12 Nov 14:08`. */
export const joinedAt = (ms: number): string => `${shortDate(ms)} ${formatClock(ms)}`;

const builtIn = /^(executor|os|arch):/;

/** The runner's own labels, without the built-in `executor:`, `os:` and `arch:` ones. */
export const ownLabels = (labels: readonly string[]): readonly string[] => labels.filter((label) => !builtIn.test(label));

/** The built-in labels, from its executor and system. */
export const builtInLabels = (executor: string, os: Page["os"]): readonly string[] => [
  `executor:${executor}`,
  ...(os === null ? [] : [`os:${os.platform === "win32" ? "windows" : os.platform === "darwin" ? "macos" : os.platform}`, `arch:${os.arch}`]),
];

/** `Linux · x64`. */
export const systemText = (os: Page["os"]): string => {
  if (os === null) return "—";
  const platform = os.platform === "linux" ? "Linux" : os.platform === "darwin" ? "macOS" : os.platform === "win32" ? "Windows" : os.platform;
  return `${platform} · ${os.arch}`;
};

/** Millicores as vCPU: `8`, or `1.5`. */
export const vcpuText = (millis: number): string => (millis % 1000 === 0 ? String(millis / 1000) : (millis / 1000).toFixed(1));

/** MiB as GiB: `16`, or `12.8`. */
export const gibText = (mib: number): string => (mib % 1024 === 0 ? String(mib / 1024) : (mib / 1024).toFixed(1));

type PageBox = Page["boxes"][number];

/**
 * A box's Size cell (runner.md, "Boxes"): `small · 2 vCPU · 4 GiB` with the limits it was made
 * with; `slot` on `host`; the name alone when it carries no limits (a minor-3 runner).
 */
export const boxSizeText = (box: Pick<PageBox, "size" | "cpuMillis" | "memoryMiB">, executor: Page["executor"]): string => {
  if (executor === "host") return t("runner.page.slot");
  if (box.size === null) return "—";
  return box.cpuMillis === null || box.memoryMiB === null ? box.size : t("runner.page.sizeLimits", { name: box.size, cpu: vcpuText(box.cpuMillis), memory: gibText(box.memoryMiB) });
};

/** A box's task, by its ticket's key, or the short ID of a prompt task. */
export const boxTaskKey = (task: Pick<PageBox["task"], "id" | "key">): string => task.key ?? task.id.slice(-7);

/** What the Executor row adds: a chip (`not isolated`) or a muted line (the internet line). */
export const executorNote = (lines: readonly FleetLine[]): readonly { readonly chip: boolean; readonly text: string }[] => {
  const out: { readonly chip: boolean; readonly text: string }[] = [];
  if (lines.includes("same-user-development")) out.push({ chip: true, text: t("runner.page.sameUser") });
  else if (lines.includes("not-isolated")) out.push({ chip: true, text: t("runners.notIsolated") });
  if (lines.includes("direct-internet-access")) out.push({ chip: false, text: t("runner.page.internet") });
  return out;
};

/** The approval panel's version word: `current`, `one minor behind`, `newer`. */
export const versionWord = (state: VersionState | null): string => {
  switch (state) {
    case null:
    case "current":
      return t("runner.approval.current");
    case "behind":
      return t("runner.approval.behind");
    case "ahead":
      return t("runner.approval.newer");
    case "outside":
      return t("runner.version.refused");
    default:
      return state satisfies never;
  }
};

/** The chip after the page's version: `outdated`, `newer` or `refused`; none when current. */
export const pageVersionChip = (state: VersionState | null): { readonly text: string; readonly red: boolean } | null => {
  switch (state) {
    case null:
    case "current":
      return null;
    case "behind":
      return { text: t("runners.version.outdated"), red: false };
    case "ahead":
      return { text: t("runners.version.newer"), red: false };
    case "outside":
      return { text: t("runner.version.refused"), red: true };
    default:
      return state satisfies never;
  }
};

/** `protocol 1.3 of 1.4`. */
export const protocolText = (minor: number | null, serverMinor: number): string =>
  minor === null ? t("runner.version.protocolServer", { server: serverMinor }) : t("runner.version.protocol", { minor, server: serverMinor });

/** The fix under the Version row (runner.md, "The fix"): by its state and how it was installed. */
export const versionFix = (state: VersionState | null, install: Page["install"], serverVersion: string, minor: number | null, serverMinor: number): string | null => {
  switch (state) {
    case null:
    case "current":
      return null;
    case "ahead":
      return t("runner.version.fixAhead");
    case "outside":
      // The server accepts one minor either way (F-061).
      return t("runner.version.fixOutside", { minor: minor ?? 0, low: Math.max(0, serverMinor - 1), high: serverMinor + 1, version: serverVersion });
    case "behind": {
      // Below minor 4 a runner gets no `resume` and applies no box size; from it on, only the update is due.
      const head = minor !== null && minor < 4 ? t("runner.version.behindHead") : t("runner.version.behindHeadUpdate");
      switch (install) {
        case "image":
          return `${head} ${t("runner.version.fixImage", { version: serverVersion })}`;
        case "npm":
          return `${head} ${t("runner.version.fixNpm", { version: serverVersion })}`;
        case "source":
          return `${head} ${t("runner.version.fixSource", { version: serverVersion })}`;
        case null:
          return `${head} ${t("runner.version.fixUnknown", { version: serverVersion })}`;
        default:
          return install satisfies never;
      }
    }
    default:
      return state satisfies never;
  }
};

/** The Install row: its word and its note. */
export const installText = (install: Page["install"]): { readonly word: string; readonly note: string | null } => {
  switch (install) {
    case "npm":
      return { word: t("runner.install.npm"), note: t("runner.install.npmNote") };
    case "image":
      return { word: t("runner.install.image"), note: null };
    case "source":
      return { word: t("runner.install.source"), note: t("runner.install.sourceNote") };
    case null:
      return { word: t("runner.install.unknown"), note: null };
    default:
      return install satisfies never;
  }
};

/** `HTTP` or `WebSocket`, from the presence row's carrier. */
const carrierName = (carrier: string): "HTTP" | "WebSocket" => (carrier.toLowerCase() === "http" ? "HTTP" : "WebSocket");

/** The Carrier row: the carrier, and on HTTP that it fell back (the trigger isn't reported yet). */
export const carrierRow = (page: Pick<Page, "connection" | "carrier">): { readonly carrier: string; readonly note: string | null; readonly faint: boolean } => {
  if (page.connection === null) return { carrier: page.carrier === null ? "—" : carrierName(page.carrier), note: null, faint: true };
  const name = carrierName(page.connection.carrier);
  return { carrier: name, note: name === "HTTP" ? t("runner.page.httpNote") : null, faint: false };
};

/** The Connection row: `Connected 2 h 14 min`, `Disconnected 40m ago`, `Never connected`. */
export const connectionText = (page: Pick<Page, "connection" | "lastSeenAt" | "state">, now: number): { readonly text: string; readonly on: boolean } => {
  if (page.connection !== null) return { text: t("runner.page.connected", { duration: formatElapsed(page.connection.since, now) }), on: true };
  if (page.state === "revoked") return { text: t("runner.page.disconnected"), on: false };
  if (page.lastSeenAt === null) return { text: t("runner.page.neverConnected"), on: false };
  return { text: t("runner.page.disconnectedAgo", { age: formatAge(page.lastSeenAt, now) }), on: false };
};

/** The lede (runner.md, "Title line and lede"), by state and kind. */
export const runnerLede = (page: Page): string => {
  switch (page.state) {
    case "joining":
      return t("runner.lede.joining");
    case "revoked":
      return t("runner.lede.revoked");
    case "draining":
      return page.drainedAt === null
        ? t("runner.lede.drainingNow")
        : t("runner.lede.draining", { since: joinedAt(page.drainedAt) });
    case "offline":
      return page.kind === "personal"
        ? t("runner.lede.personalOffline")
        : t("runner.lede.offline", { executor: page.executor, pool: page.pool?.name ?? "—", since: page.lastSeenAt === null ? "—" : formatClock(page.lastSeenAt) });
    case "online": {
      if (page.kind === "personal") return t("runner.lede.personal", { executor: page.executor, busy: page.busy, slots: page.slots });
      const head = t("runner.lede.online", { executor: page.executor, pool: page.pool?.name ?? "—", busy: page.busy, slots: page.slots });
      return page.connection !== null && carrierName(page.connection.carrier) === "HTTP" ? `${head.slice(0, -1)}${t("runner.lede.onHttp", { since: formatClock(page.connection.since) })}` : head;
    }
    default:
      return page.state satisfies never;
  }
};

/** A History entry's sentence, from the audit action and its actor. */
export const historyText = (action: string, actor: string | null, pool: string | null): string => {
  const who = actor ?? t("common.unknown");
  switch (action) {
    case "runner.approved":
      return t("runner.history.approved", { who });
    case "runner.rejected":
      return t("runner.history.rejected", { who });
    case "runner.drained":
      return t("runner.history.drained", { who });
    case "runner.resumed":
      return t("runner.history.resumed", { who });
    case "runner.revoked":
      return t("runner.history.revoked", { who });
    case "runner.joined":
      return pool === null ? t("runner.history.joinedPersonal") : t("runner.history.joined", { pool });
    case "runner.registered":
      return t("runner.history.registered");
    case "runner.connected":
      return t("runner.history.connected");
    case "runner.lost":
      return t("runner.history.lost");
    case "runner.version-refused":
      return t("runner.history.versionRefused");
    case "runner.reserved-labels-dropped":
      return t("runner.history.labelsDropped");
    default:
      return action;
  }
};

/** The panel's last line: what Drain, Resume and Revoke would do now. */
export const consequenceLine = (state: Page["state"], busy: number, own: boolean): string | null => {
  if (state === "revoked" || state === "joining") return null;
  if (own) return t("runner.page.consequenceOwn");
  if (state === "draining") return busy === 0 ? t("runner.page.consequenceResumeIdle") : busy === 1 ? t("runner.page.consequenceResumeOne") : t("runner.page.consequenceResume", { n: busy });
  return busy === 0 ? t("runner.page.consequenceIdle") : busy === 1 ? t("runner.page.consequenceOne") : t("runner.page.consequence", { n: busy });
};
