import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { epochMsSchema, httpUrlSchema, poolIdSchema, runnerIdSchema, runnerKindSchema } from "@ostra/protocol";
import { z } from "zod";
import { keyPairFromPem, privateKeyToPem } from "./key-pair.ts";
import type { RunnerKeyPair } from "./key-pair.ts";
import { makeOwnerOnlyDir, writeOwnerOnlyFile } from "./owner-only.ts";

// The runner's data folder (`OSTRA_RUNNER_DATA_DIR`, default `~/.ostra/runner`):
//
//   identity/          owner-only
//     runner.key       the Ed25519 private key, PKCS#8 PEM, owner-only
//     runner.json      the runner's ID, its server and how it registered
//   status.json        what `ostra runner status` shows: the version window, the last refusal
//   spool/             the event spool, per session (ticket 16)
//   state.json         the commands applied, and the sessions held (ticket 16)
//   tasks/             the task workspaces (the host executor, ticket 19)
//
// ostra owns these formats, so they're strict. A file that doesn't parse is treated as missing,
// except the identity, which is refused with a message: a runner never re-registers silently.

/** The default data folder when `OSTRA_RUNNER_DATA_DIR` is unset (`docs/configuration.md`). */
export const defaultDataDir = (): string => path.join(os.homedir(), ".ostra", "runner");

export const dataPaths = (dataDir: string) =>
  ({
    identityDir: path.join(dataDir, "identity"),
    privateKey: path.join(dataDir, "identity", "runner.key"),
    identity: path.join(dataDir, "identity", "runner.json"),
    status: path.join(dataDir, "status.json"),
    spoolDir: path.join(dataDir, "spool"),
    state: path.join(dataDir, "state.json"),
    tasksDir: path.join(dataDir, "tasks"),
  }) as const;

export const identityRecordSchema = z.strictObject({
  runnerId: runnerIdSchema,
  /** The core address it registered with. A data folder belongs to one server. */
  serverUrl: httpUrlSchema,
  kind: runnerKindSchema,
  poolId: poolIdSchema.nullable(),
  name: z.string().min(1).max(128),
  registeredAt: epochMsSchema,
});
export type IdentityRecord = z.infer<typeof identityRecordSchema>;

export type RunnerIdentity = { readonly record: IdentityRecord; readonly keyPair: RunnerKeyPair };

export type LoadIdentity =
  | { readonly kind: "none" }
  | { readonly kind: "found"; readonly identity: RunnerIdentity }
  | { readonly kind: "broken"; readonly message: string };

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const writeAtomic = async (file: string, text: string): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${String(process.pid)}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, file);
};

export const loadIdentity = async (dataDir: string): Promise<LoadIdentity> => {
  const paths = dataPaths(dataDir);
  let recordText: string;
  let pem: string;
  try {
    recordText = await readFile(paths.identity, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return { kind: "none" };
    }
    return { kind: "broken", message: `can't read ${paths.identity}` };
  }
  try {
    pem = await readFile(paths.privateKey, "utf8");
  } catch {
    return { kind: "broken", message: `${paths.identity} exists but its key ${paths.privateKey} can't be read` };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(recordText);
  } catch {
    return { kind: "broken", message: `${paths.identity} is not JSON` };
  }
  const record = identityRecordSchema.safeParse(parsedJson);
  if (!record.success) {
    return { kind: "broken", message: `${paths.identity} is not a runner identity` };
  }
  try {
    return { kind: "found", identity: { record: record.data, keyPair: keyPairFromPem(pem) } };
  } catch {
    return { kind: "broken", message: `${paths.privateKey} doesn't hold the runner's key` };
  }
};

/** Writes the key first, owner-only, then the record that says the runner exists. */
export const saveIdentity = async (dataDir: string, identity: RunnerIdentity): Promise<void> => {
  const paths = dataPaths(dataDir);
  await makeOwnerOnlyDir(paths.identityDir);
  await writeOwnerOnlyFile(paths.privateKey, privateKeyToPem(identity.keyPair));
  await writeAtomic(paths.identity, `${JSON.stringify(identity.record, null, 2)}\n`);
};

/** Forgets the identity, so the next start signs in again (after a revocation). */
export const forgetIdentity = async (dataDir: string): Promise<void> => {
  await rm(dataPaths(dataDir).identityDir, { recursive: true, force: true });
};

// ---------- status.json ----------

export const refusalReasonSchema = z.enum(["revoked", "version-unsupported", "replaced", "unreachable", "invalid-response"]);
export type RefusalReason = z.infer<typeof refusalReasonSchema>;

export const runnerStatusRecordSchema = z.strictObject({
  /** The server's window at the last contact. */
  versionWindow: z
    .strictObject({
      protocolMajor: z.number().int().nonnegative(),
      serverMinor: z.number().int().nonnegative(),
      min: z.number().int().nonnegative(),
      max: z.number().int().nonnegative(),
      serverVersion: z.string().min(1).max(64),
    })
    .nullable(),
  lastRefusal: z
    .strictObject({ at: epochMsSchema, reason: refusalReasonSchema, message: z.string().max(2000) })
    .nullable(),
  lastConnectedAt: epochMsSchema.nullable(),
});
export type RunnerStatusRecord = z.infer<typeof runnerStatusRecordSchema>;

const emptyStatus: RunnerStatusRecord = { versionWindow: null, lastRefusal: null, lastConnectedAt: null };

export const loadStatus = async (dataDir: string): Promise<RunnerStatusRecord> => {
  try {
    const parsed = runnerStatusRecordSchema.safeParse(JSON.parse(await readFile(dataPaths(dataDir).status, "utf8")));
    return parsed.success ? parsed.data : emptyStatus;
  } catch {
    return emptyStatus;
  }
};

let statusChain: Promise<unknown> = Promise.resolve();

/** Merges `change` into status.json. Writes are serialized, so two updates never interleave. */
export const updateStatus = (dataDir: string, change: Partial<RunnerStatusRecord>): Promise<void> => {
  const next = statusChain.then(async () => {
    const current = await loadStatus(dataDir);
    await writeAtomic(dataPaths(dataDir).status, `${JSON.stringify({ ...current, ...change }, null, 2)}\n`);
  });
  statusChain = next.catch(() => undefined);
  return next;
};
