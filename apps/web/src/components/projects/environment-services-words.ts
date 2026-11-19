import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// The words of the environment's Services and checks tab and its snapshot panel
// (environment-services.md), kept apart from the components so they're tested on their own.

type ServiceView = RouterOutputs["environments"]["services"]["list"][number];
type SnapshotView = RouterOutputs["environments"]["snapshot"]["get"];
type WhereTasksRun = RouterOutputs["environments"]["get"]["whereTasksRun"];

/** "10 min" for whole minutes, otherwise "90 s". */
export const timeoutText = (seconds: number): string =>
  seconds % 60 === 0 ? t("environment.chk.minutes", { n: seconds / 60 }) : t("environment.chk.seconds", { n: seconds });

/** "3 · 1 secret", "1", or `null` for none (the cell reads `none`). */
export const variablesText = (variables: ServiceView["variables"]): string | null => {
  if (variables.length === 0) return null;
  const secrets = variables.filter((variable) => variable.kind === "secret").length;
  if (secrets === 0) return String(variables.length);
  return t(secrets === 1 ? "environment.svc.variablesSecret" : "environment.svc.variablesSecrets", { count: variables.length, secrets });
};

/** "build-fleet", "build-fleet and gpu-pool", "a, b and c". */
export const poolsText = (pools: readonly string[]): string => {
  if (pools.length <= 1) return pools[0] ?? "";
  return `${pools.slice(0, -1).join(", ")}${t("environment.svc.and")}${pools.at(-1) ?? ""}`;
};

/** "2h ago" in the panel's short form, or "now". */
export const agoShort = (since: number, now: number = Date.now()): string => {
  const age = formatAge(since, now);
  return age === "now" ? t("environment.justNow") : t("environment.ago", { age });
};

/** What the services' note or blocker under the table says, or `null` with no services. */
export type RunnerNote =
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "blocked"; readonly detail: string };

export const runnerNote = (where: WhereTasksRun): RunnerNote | null => {
  if (where.services === 0) return null;
  const pools = poolsText(where.pools.map((pool) => pool.name));
  if (where.noServicesRunner) {
    const noDocker = !where.poolExecutors.includes("docker") && !where.poolExecutors.includes("kubernetes");
    return { kind: "blocked", detail: t(noDocker ? "environment.svc.blockedNoDocker" : "environment.svc.blockedOffline", { pools }) };
  }
  if (where.pools.length === 0) return { kind: "note", text: t("environment.svc.runnerNoteNoPools") };
  return {
    kind: "note",
    text: t(where.pools.length === 1 ? "environment.svc.runnerNoteOne" : "environment.svc.runnerNoteMany", { pools, count: where.servicesRunnersOnline }),
  };
};

/** The list with the item at `from` moved to `to`. */
export const moved = <T,>(items: readonly T[], from: number, to: number): T[] => {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined || to < 0 || to > next.length) return [...items];
  next.splice(to, 0, item);
  return next;
};

/** Why a snapshot was built, for the panel's "Why". */
export const snapshotReasonText = (reason: NonNullable<SnapshotView["ready"]>["reason"], requestedBy: string | null): string => {
  switch (reason) {
    case "environment-changed":
      return t("environment.snap.reasonEnvironment");
    case "lockfile-changed":
      return t("environment.snap.reasonLockfile");
    case "nightly":
      return t("environment.snap.reasonNightly");
    case "rebuild":
      return requestedBy === null ? t("environment.snap.reasonRebuild") : t("environment.snap.rebuiltBy", { name: requestedBy });
    default:
      return reason satisfies never;
  }
};

/** A failed build's reason, in words. */
export const snapshotFailureText = (reason: NonNullable<SnapshotView["lastFailure"]>["reason"]): string => {
  switch (reason) {
    case "setup-failed":
      return t("environment.snap.failSetup");
    case "secret-found":
      return t("environment.snap.failSecret");
    case "build-failed":
      return t("environment.snap.failBuild");
    default:
      return reason satisfies never;
  }
};

/** `sha256:9c41e2a`: the digest's first 7 hex digits. */
export const shortDigest = (digest: string): string => {
  const [algorithm, hex = ""] = digest.split(":");
  return `${algorithm ?? "sha256"}:${hex.slice(0, 7)}`;
};

/** A service's health on its last box: the dot, the word and the time beside it. */
export const healthOf = (lastBox: ServiceView["lastBox"]): { readonly tone: "green" | "red" | "grey"; readonly word: string; readonly extra: string | null } | null => {
  if (lastBox === null) return null;
  switch (lastBox.state) {
    case "healthy":
      return { tone: "green", word: t("environment.svc.healthy"), extra: lastBox.afterMs === null ? null : `${String(Math.max(1, Math.round(lastBox.afterMs / 1000)))}s` };
    case "failed":
      return { tone: "red", word: t("environment.svc.failed"), extra: null };
    case "started":
      return { tone: "grey", word: t("environment.svc.started"), extra: t("environment.svc.noCheck") };
    default:
      return lastBox.state satisfies never;
  }
};

/** "Waiting for a runner that can start services. Online now: alex-mbp (host)." */
export const servicesWaitText = (online: readonly { readonly name: string; readonly executor: string }[]): string =>
  online.length === 0
    ? t("taskPage.servicesWaitNone")
    : t("taskPage.servicesWait", { runners: online.map((runner) => `${runner.name} (${runner.executor})`).join(", ") });
