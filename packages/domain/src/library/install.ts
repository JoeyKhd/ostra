import type { SecretRef } from "@ostra/adapter-sdk";
import { Prisma } from "@ostra/db";
import type { Tx } from "@ostra/db";
import { HTTP_HEADER_VALUE, libraryItemIdSchema, libraryItemVersionIdSchema } from "@ostra/protocol";
import type { GitSha, LibraryItemId, LibraryItemVersionId, MemberId, OrganizationId } from "@ostra/protocol";

import { requireOrganizationAdmin } from "../access.ts";
import type {
  InstallItem,
  InstallItemInput,
  LibraryDeps,
  ResolvedSkill,
  ResolveReference,
  ResolveReferenceError,
  ServerInputSpec,
  ServerInputValue,
  TestServer,
} from "../use-cases/m8-library-signatures.ts";
import { allowed, allowlistEntryFor } from "./allowed.ts";
import type { AllowlistSubject } from "./allowed.ts";
import { readGitHubSkillForInstall, readGitHubSkills, sha256Hex } from "./github-source.ts";
import type { GitHubSourceDeps, SkillRead, SourceFailure } from "./github-source.ts";
import { listMcpTools } from "./mcp-test-call.ts";
import type { OutboundDeps } from "./outbound.ts";
import { librarySourceKindOf, librarySourceSchema, parseLibraryReference } from "./reference.ts";
import type { LibraryReference, LibrarySource } from "./reference.ts";
import { readRegistryServer, serverItemNameOf, serverOfferOf, serverRefusalWords, templateVariables } from "./registry-source.ts";
import { remoteUrlWith, serverRequestOf } from "./server-request.ts";
import { addSourceInTx, allowlistOf } from "./sources.ts";
import { libraryVersionFilesSchema, storedServerEntrySchema, storedServerInputsSchema, storedToolNamesSchema } from "./stored.ts";
import type { LibraryVersionFile, StoredServerEntry, StoredServerInput, StoredServerInputs } from "./stored.ts";
import { readWellKnownSkills } from "./well-known-source.ts";

// F-145 (ADR 0069, spec sections 4 and 5.4, ticket 27): the library's install by reference.
// - `resolveReference`, an organization admin's look, writes nothing: the commit and the skills
//   found, each checked and hashed, or a registry entry's remote and inputs, and whether the
//   source is on the allowlist.
// - `installItem` checks the allowlist (adding the source in the same call when the admin asked,
//   with its own audit entry), reads the source again at the look's commit or version and refuses
//   a hash that changed, writes a skill's files as blobs (`library-file`, no task), a server's
//   secret inputs through the secret store as references, and the item with its first version in
//   one transaction with the audit entry.
// - `testServer` lists a server's tools from core with its headers, and marks one that asks for
//   an OAuth sign-in (Q321), which can't be attached (ticket 28).
// Lines carry the organization, the item's ID, its kind and its source kind: never a file's
// content, a header's value, a secret or a reference's text.

/** The secret store's purpose for a server's secret input. */
export const LIBRARY_SECRET_PURPOSE = "library-server-input";
const SECRET_PURPOSE = LIBRARY_SECRET_PURPOSE;

const refuse = <E extends string>(error: E, message: string): { readonly ok: false; readonly error: E; readonly message: string } => ({ ok: false, error, message });

const githubDeps = (deps: LibraryDeps): GitHubSourceDeps => ({ db: deps.db, codeHost: deps.adapters.codeHost, secretStore: deps.adapters.secretStore });
const outbound = (deps: Pick<LibraryDeps, "fetch" | "serverVersion">): OutboundDeps => ({ fetch: deps.fetch, serverVersion: deps.serverVersion });

const loggerOf = (deps: Pick<LibraryDeps, "logger">) => deps.logger.child({ component: "library" });

/** A source's refusal, as the look's and the install's error. */
const failed = (failure: SourceFailure | { readonly ok: false; readonly error: "digest-mismatch"; readonly message: string }): { readonly ok: false; readonly error: ResolveReferenceError; readonly message: string } =>
  refuse(failure.error, failure.message);

const resolvedSkillOf = (read: SkillRead): ResolvedSkill => ({
  folder: read.folder,
  check: read.check,
  scripts: read.scripts,
  files: read.files.map((file) => ({ path: file.path, size: file.bytes.length, sha256: sha256Hex(file.bytes), executable: file.executable })),
  computedHash: read.computedHash,
});

const subjectOfReference = (reference: Exclude<LibraryReference, { readonly kind: "registry" }>): AllowlistSubject =>
  reference.kind === "github" ? { kind: "github", owner: reference.owner, repo: reference.repo } : { kind: "well_known", url: reference.url };

const inputsOf = (entry: NonNullable<ReturnType<typeof serverOfferOf>["entry"]>): ServerInputSpec[] => [
  ...entry.variables.map((variable) => ({ kind: "variable" as const, ...variable })),
  ...entry.headers.map((header) => ({ kind: "header" as const, ...header })),
];

// ---------- the look ----------

/** An organization admin's look at a reference before installing it. Writes nothing. */
export const resolveReference: ResolveReference = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin installs into the library");
  }
  const parsed = parseLibraryReference(input.reference);
  if (!parsed.ok) {
    return refuse("invalid-reference", parsed.error);
  }
  const reference = parsed.value;
  const logger = loggerOf(deps);
  const sources = await allowlistOf(deps.db, organizationId);
  switch (reference.kind) {
    case "github":
    case "well_known": {
      const read = reference.kind === "github" ? await readGitHubSkills(githubDeps(deps), organizationId, reference) : await readWellKnownSkills(outbound(deps), reference.url, null);
      if (!read.ok) {
        logger.info("library.resolve.refused", { organizationId, sourceKind: reference.kind, error: read.error });
        return failed(read);
      }
      const subject = subjectOfReference(reference);
      const skills = read.skills.map(resolvedSkillOf);
      logger.info("library.resolved", { organizationId, sourceKind: reference.kind, skills: skills.length });
      return {
        ok: true,
        reference,
        resolved: {
          kind: "skills",
          source: reference.kind === "github" ? { kind: "github", owner: reference.owner, repo: reference.repo } : { kind: "well_known", url: reference.url },
          commit: "at" in read ? read.at.commit : null,
          skills,
          tooDeep: "tooDeep" in read ? read.tooDeep : 0,
          allowed: allowed(subject, sources),
          entryToAllow: allowlistEntryFor(subject),
        },
      };
    }
    case "registry": {
      const read = await readRegistryServer({ ...outbound(deps), db: deps.db }, organizationId, reference, "latest");
      if (!read.ok) {
        logger.info("library.resolve.refused", { organizationId, sourceKind: reference.kind, error: read.error });
        return failed(read);
      }
      const offer = serverOfferOf(read.entry);
      const subject: AllowlistSubject = { kind: "registry", registryUrl: read.registryUrl, name: reference.name };
      logger.info("library.resolved", { organizationId, sourceKind: reference.kind, refusal: offer.refusal });
      return {
        ok: true,
        reference,
        resolved: {
          kind: "server",
          registryUrl: read.registryUrl,
          name: reference.name,
          version: read.entry.server.version,
          description: read.entry.server.description?.slice(0, 4096) ?? null,
          remoteUrl: offer.entry?.remoteUrl ?? null,
          inputs: offer.entry === null ? [] : inputsOf(offer.entry),
          refusal: offer.refusal,
          allowed: allowed(subject, sources),
          entryToAllow: allowlistEntryFor(subject),
        },
      };
    }
    default:
      return reference satisfies never;
  }
};

// ---------- the install ----------

type InstallError = Extract<Awaited<ReturnType<InstallItem>>, { readonly ok: false }>["error"];
type InstallResult = Awaited<ReturnType<InstallItem>>;

const isUniqueViolation = (error: unknown): boolean => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

const nameTaken = (kind: "skill" | "mcp_server", name: string): { readonly ok: false; readonly error: InstallError; readonly message: string } =>
  refuse("name-taken", `The library already has ${kind === "skill" ? "a skill" : "an MCP server"} named ${name}`);

/** What every install writes, in one transaction: the source when asked, the item, its first version, the audit entry and the notice. */
type ItemWrite = {
  readonly organizationId: OrganizationId;
  readonly memberId: MemberId;
  readonly kind: "skill" | "mcp_server";
  readonly name: string;
  readonly source: LibrarySource;
  readonly addSource: AllowlistSubject | null;
  readonly version: Omit<Prisma.LibraryItemVersionUncheckedCreateInput, "organizationId" | "itemId" | "number" | "state" | "fetchedAt">;
};

const writeItem = (deps: LibraryDeps, write: ItemWrite): Promise<{ readonly itemId: LibraryItemId; readonly versionId: LibraryItemVersionId }> =>
  deps.db.$transaction(async (tx: Tx) => {
    const now = new Date(deps.clock.now());
    if (write.addSource !== null) {
      await addSourceInTx(deps, tx, { organizationId: write.organizationId, entry: allowlistEntryFor(write.addSource), by: write.memberId, via: "install" });
    }
    const item = await tx.libraryItem.create({
      data: {
        organizationId: write.organizationId,
        kind: write.kind,
        name: write.name,
        sourceKind: librarySourceKindOf(write.source),
        source: librarySourceSchema.parse(write.source),
        installedByMemberId: write.memberId,
        installedAt: now,
      },
      select: { id: true },
    });
    const version = await tx.libraryItemVersion.create({
      data: { ...write.version, organizationId: write.organizationId, itemId: item.id, number: 1, state: "current", fetchedAt: now },
      select: { id: true },
    });
    await tx.libraryItem.update({ where: { id: item.id }, data: { currentVersionId: version.id } });
    const itemId = libraryItemIdSchema.parse(item.id);
    await deps.audit.recordInTx(tx, {
      organizationId: write.organizationId,
      projectId: null,
      actor: { kind: "member", id: write.memberId },
      action: "library.installed",
      entity: "library-item",
      entityId: itemId,
      data: { kind: write.kind, name: write.name, sourceKind: librarySourceKindOf(write.source), version: 1, sourceAdded: write.addSource !== null },
    });
    await deps.notices.emitInTx(tx, { organizationId: write.organizationId, projectId: null, entity: "organization", entityId: write.organizationId });
    return { itemId, versionId: libraryItemVersionIdSchema.parse(version.id) };
  });

const nameIsTaken = async (deps: LibraryDeps, organizationId: OrganizationId, kind: "skill" | "mcp_server", name: string): Promise<boolean> =>
  (await deps.db.libraryItem.findFirst({ where: { organizationId, kind, name, removedAt: null }, select: { id: true } })) !== null;

/** Whether the list allows the subject, or the admin asked to add it in the same call; `null` when it's refused. */
const allowSourceOf = async (deps: LibraryDeps, organizationId: OrganizationId, subject: AllowlistSubject, allowSource: boolean): Promise<{ readonly add: AllowlistSubject | null } | null> => {
  if (allowed(subject, await allowlistOf(deps.db, organizationId)).allowed) {
    return { add: null };
  }
  return allowSource ? { add: subject } : null;
};

const NOT_ALLOWED = "Its source isn't on the organization's list of sources: add it, here or on the list, to install from it";

/** A skill: read again at the look's commit (or the site's index), the hash compared, the files written as blobs. */
const installSkill = async (deps: LibraryDeps, organizationId: OrganizationId, memberId: MemberId, reference: LibraryReference, input: Extract<InstallItemInput, { readonly kind: "skill" }>): Promise<InstallResult> => {
  const logger = loggerOf(deps);
  if (reference.kind === "registry") {
    return refuse("invalid-reference", "A registry holds MCP servers: a skill comes from a GitHub repo or a site's well-known index");
  }
  // The list first: a source that isn't on it, and isn't being added, is never called again.
  const allow = await allowSourceOf(deps, organizationId, subjectOfReference(reference), input.allowSource);
  if (allow === null) {
    logger.info("library.install.refused", { organizationId, kind: "skill", sourceKind: reference.kind, error: "not-allowed" });
    return refuse("not-allowed", NOT_ALLOWED);
  }
  let read: { readonly skill: SkillRead; readonly commit: GitSha | null } | SourceFailure | { readonly ok: false; readonly error: "digest-mismatch"; readonly message: string };
  if (reference.kind === "github") {
    if (input.commit === null) {
      return refuse("invalid-input", "A skill from GitHub installs at the commit its look resolved");
    }
    const fetched = await readGitHubSkillForInstall(githubDeps(deps), organizationId, reference, input.folder, input.commit);
    read = fetched.ok ? { skill: fetched.skill, commit: fetched.at.commit } : fetched;
  } else {
    const fetched = await readWellKnownSkills(outbound(deps), reference.url, input.folder);
    read = fetched.ok ? (fetched.skills[0] === undefined ? refuse("not-found", "The site's index has no such skill") : { skill: fetched.skills[0], commit: null }) : fetched;
  }
  if ("ok" in read) {
    logger.info("library.install.refused", { organizationId, kind: "skill", sourceKind: reference.kind, error: read.error });
    return failed(read);
  }
  const { skill, commit } = read;
  if (skill.computedHash !== input.computedHash) {
    logger.info("library.install.refused", { organizationId, kind: "skill", sourceKind: reference.kind, error: "hash-changed" });
    return refuse("hash-changed", "The skill's files changed since the look: look again before installing");
  }
  if (!skill.check.ok) {
    return refuse("skill-refused", skill.check.problems.map((problem) => problem.message).join(". "));
  }
  const name = skill.check.name;
  if (await nameIsTaken(deps, organizationId, "skill", name)) {
    return nameTaken("skill", name);
  }
  const ref = reference.kind === "github" && reference.ref !== null ? (reference.ref.kind === "commit" ? reference.ref.sha : reference.ref.name) : null;
  const source: LibrarySource =
    reference.kind === "github" ? { kind: "github", owner: reference.owner, repo: reference.repo, path: input.folder, ref } : { kind: "well_known", url: reference.url, skill: name };
  const files: LibraryVersionFile[] = [];
  for (const file of skill.files) {
    const stored = await deps.blobs.put(organizationId, file.bytes);
    if (!stored.ok) {
      logger.warn("library.install.blob-failed", { organizationId, kind: "skill", sourceKind: reference.kind });
      return refuse("unavailable", `A skill's file couldn't be stored: ${stored.message}`);
    }
    files.push({ path: file.path, blobId: stored.blobId, size: file.bytes.length, sha256: sha256Hex(file.bytes), executable: file.executable });
  }
  try {
    const written = await writeItem(deps, {
      organizationId,
      memberId,
      kind: "skill",
      name,
      source,
      addSource: allow.add,
      version: { ref, commitSha: commit, computedHash: skill.computedHash, files: libraryVersionFilesSchema.parse(files) },
    });
    logger.info("library.installed", { organizationId, itemId: written.itemId, kind: "skill", sourceKind: reference.kind, files: files.length });
    return { ok: true, ...written };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return nameTaken("skill", name);
    }
    throw error;
  }
};

/** A URL variable's value: no control character and no space, at most 1 KiB. */
const VARIABLE_VALUE = /^[^\s\u0000-\u001f\u007f]{1,1024}$/;

type CollectedInput = { readonly secret: boolean; readonly value: string };

/**
 * The admin's values for a server's inputs, by name: every required one, no unknown one, each
 * one that can be sent. A value is kept secret when the entry says so, or the admin does.
 */
const collectInputs = (
  specs: readonly { readonly name: string; readonly isSecret: boolean; readonly isRequired: boolean }[],
  given: Readonly<Record<string, ServerInputValue>>,
  defaults: Readonly<Record<string, string>>,
  kind: "variable" | "header",
): { readonly ok: true; readonly values: ReadonlyMap<string, CollectedInput> } | { readonly ok: false; readonly message: string } => {
  const values = new Map<string, CollectedInput>();
  for (const name of Object.keys(given)) {
    if (!specs.some((spec) => spec.name === name)) {
      return { ok: false, message: `The server asks for no ${kind} named ${name}` };
    }
  }
  for (const spec of specs) {
    const value = Object.hasOwn(given, spec.name) ? given[spec.name] : undefined;
    const text = value === undefined ? defaults[spec.name] : kind === "header" ? value.value.trim() : value.value;
    if (text === undefined || text === "") {
      if (spec.isRequired) {
        return { ok: false, message: `The server needs its ${kind} ${spec.name}` };
      }
      continue;
    }
    if (kind === "header" ? text.length > 8192 || !HTTP_HEADER_VALUE.test(text) : !VARIABLE_VALUE.test(text)) {
      return { ok: false, message: `The ${kind} ${spec.name} holds a character it can't be sent with` };
    }
    values.set(spec.name, { secret: spec.isSecret || value?.kind === "secret", value: text });
  }
  return { ok: true, values };
};

/** A server: its entry read again at the look's version, its inputs checked, its secrets in the secret store. */
const installServer = async (deps: LibraryDeps, organizationId: OrganizationId, memberId: MemberId, reference: LibraryReference, input: Extract<InstallItemInput, { readonly kind: "server" }>): Promise<InstallResult> => {
  const logger = loggerOf(deps);
  if (reference.kind !== "registry") {
    return refuse("invalid-reference", "An MCP server comes from a registry: registry:<server name>");
  }
  const read = await readRegistryServer({ ...outbound(deps), db: deps.db }, organizationId, reference, input.version);
  if (!read.ok) {
    logger.info("library.install.refused", { organizationId, kind: "mcp_server", sourceKind: "registry", error: read.error });
    return failed(read);
  }
  const offer = serverOfferOf(read.entry);
  if (offer.entry === null || offer.refusal !== null) {
    logger.info("library.install.refused", { organizationId, kind: "mcp_server", sourceKind: "registry", error: "server-refused", refusal: offer.refusal });
    return refuse("server-refused", serverRefusalWords(offer.refusal ?? "no-remote"));
  }
  const entry = offer.entry;
  const variables = collectInputs(entry.variables, input.variables, offer.defaults.variables, "variable");
  const headers = collectInputs(entry.headers, input.headers, offer.defaults.headers, "header");
  if (!variables.ok) {
    return refuse("invalid-input", variables.message);
  }
  if (!headers.ok) {
    return refuse("invalid-input", headers.message);
  }
  const plainVariables = new Map([...variables.values].map(([name, value]) => [name, value.value]));
  if (templateVariables(entry.remoteUrl).some((name) => !plainVariables.has(name)) || remoteUrlWith(entry.remoteUrl, plainVariables) === null) {
    return refuse("invalid-input", "The server's address, with its variables put in, isn't an https address");
  }
  const subject: AllowlistSubject = { kind: "registry", registryUrl: read.registryUrl, name: reference.name };
  const allow = await allowSourceOf(deps, organizationId, subject, input.allowSource);
  if (allow === null) {
    logger.info("library.install.refused", { organizationId, kind: "mcp_server", sourceKind: "registry", error: "not-allowed" });
    return refuse("not-allowed", NOT_ALLOWED);
  }
  const name = serverItemNameOf(reference.name);
  if (await nameIsTaken(deps, organizationId, "mcp_server", name)) {
    return nameTaken("mcp_server", name);
  }
  // Each secret into the secret store first: the version keeps only its reference.
  const written: SecretRef[] = [];
  const forget = async (): Promise<void> => {
    for (const ref of written) {
      await deps.adapters.secretStore.delete(organizationId, ref);
    }
  };
  const store = async (values: ReadonlyMap<string, CollectedInput>): Promise<Record<string, StoredServerInput> | null> => {
    const kept: Record<string, StoredServerInput> = {};
    for (const [inputName, value] of values) {
      if (!value.secret) {
        kept[inputName] = { kind: "plain", value: value.value };
        continue;
      }
      const ref = await deps.adapters.secretStore.put({ organizationId, purpose: SECRET_PURPOSE }, value.value);
      if (!ref.ok) {
        return null;
      }
      written.push(ref.value);
      kept[inputName] = { kind: "secret", ref: ref.value };
    }
    return kept;
  };
  const storedVariables = await store(variables.values);
  const storedHeaders = storedVariables === null ? null : await store(headers.values);
  if (storedVariables === null || storedHeaders === null) {
    await forget();
    logger.warn("library.install.secret-failed", { organizationId, kind: "mcp_server", sourceKind: "registry" });
    return refuse("unavailable", "A secret input couldn't be written to the secret store");
  }
  const inputs: StoredServerInputs = { variables: storedVariables, headers: storedHeaders };
  try {
    const item = await writeItem(deps, {
      organizationId,
      memberId,
      kind: "mcp_server",
      name,
      source: { kind: "registry", registryUrl: read.registryUrl, name: reference.name },
      addSource: allow.add,
      version: {
        registryVersion: read.entry.server.version,
        serverEntry: storedServerEntrySchema.parse(entry),
        serverInputs: storedServerInputsSchema.parse(inputs),
      },
    });
    logger.info("library.installed", { organizationId, itemId: item.itemId, kind: "mcp_server", sourceKind: "registry", secrets: written.length });
    return { ok: true, ...item };
  } catch (error) {
    await forget();
    if (isUniqueViolation(error)) {
      return nameTaken("mcp_server", name);
    }
    throw error;
  }
};

/** An organization admin installs what a look showed: at the same commit or version, or not at all. */
export const installItem: InstallItem = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin installs into the library; a member suggests");
  }
  const parsed = parseLibraryReference(input.reference);
  if (!parsed.ok) {
    return refuse("invalid-reference", parsed.error);
  }
  switch (input.kind) {
    case "skill":
      return installSkill(deps, organizationId, scope.memberId, parsed.value, input);
    case "server":
      return installServer(deps, organizationId, scope.memberId, parsed.value, input);
    default:
      return input satisfies never;
  }
};

// ---------- the test call ----------

type TestCallResult = Awaited<ReturnType<TestServer>>;

/**
 * The test call to a server's version, from core with its headers, with no access check: the tools'
 * names or the OAuth mark, or why it failed, in the dialog's words. Attaching a server never
 * tested (ticket 28) and the update check's fresh test call make it too.
 */
export const testCallOf = async (
  deps: Pick<LibraryDeps, "adapters" | "fetch" | "serverVersion" | "logger">,
  organizationId: OrganizationId,
  itemId: LibraryItemId,
  entry: StoredServerEntry,
  inputs: StoredServerInputs,
): Promise<TestCallResult> => {
  const logger = loggerOf(deps);
  const request = await serverRequestOf(deps.adapters.secretStore, organizationId, entry, inputs);
  if (!request.ok) {
    switch (request.error) {
      case "secret-unreadable":
        return refuse("unavailable", "A secret input couldn't be read from the secret store");
      case "bad-address":
        return refuse("invalid-response", "The server's address, with its variables put in, isn't an https address");
      case "bad-header":
        return refuse("invalid-response", "A header of the server's holds a character it can't be sent with");
      default:
        return request.error satisfies never;
    }
  }
  const listed = await listMcpTools(outbound(deps), request.url, request.headers);
  switch (listed.kind) {
    case "tools":
      return { ok: true, toolNames: listed.names, needsOAuth: false };
    case "oauth":
      return { ok: true, toolNames: [], needsOAuth: true };
    case "refused":
      logger.info("library.server.test-refused", { organizationId, itemId, kind: "mcp_server", sourceKind: "registry", status: listed.status });
      return refuse("unavailable", `The server refused the test call (HTTP ${String(listed.status)}): check its headers`);
    case "unavailable":
      logger.info("library.server.test-failed", { organizationId, itemId, kind: "mcp_server", sourceKind: "registry", reason: listed.reason, status: listed.status });
      return refuse(
        "unavailable",
        listed.reason === "timeout" ? "The server didn't answer the test call within 10 s" : listed.reason === "status" ? `The server answered the test call with HTTP ${String(listed.status)}` : "The server couldn't be reached",
      );
    case "invalid":
      logger.info("library.server.test-failed", { organizationId, itemId, kind: "mcp_server", sourceKind: "registry", reason: "invalid" });
      return refuse("invalid-response", "The server's answer to the test call isn't an MCP tool list");
    default:
      return listed satisfies never;
  }
};

/**
 * The test call on an item's current version, its tools' names or the OAuth mark kept on the
 * version, with no access check: the admin's `testServer`, and an attach of a server whose
 * version lists no tools yet (ticket 28).
 */
export const testCurrentVersion = async (deps: LibraryDeps, organizationId: OrganizationId, itemId: LibraryItemId): Promise<TestCallResult> => {
  const item = await deps.db.libraryItem.findFirst({
    where: { id: itemId, organizationId, kind: "mcp_server", removedAt: null },
    select: { id: true, currentVersion: { select: { id: true, serverEntry: true, serverInputs: true } } },
  });
  const entry = storedServerEntrySchema.safeParse(item?.currentVersion?.serverEntry);
  const inputs = storedServerInputsSchema.safeParse(item?.currentVersion?.serverInputs);
  const versionId = item?.currentVersion?.id;
  if (item === null || versionId === undefined || !entry.success || !inputs.success) {
    return refuse("not-found", "No such MCP server in the library");
  }
  const tested = await testCallOf(deps, organizationId, itemId, entry.data, inputs.data);
  if (!tested.ok) {
    return tested;
  }
  await deps.db.$transaction(async (tx) => {
    await tx.libraryItemVersion.update({ where: { id: versionId }, data: { toolNames: storedToolNamesSchema.parse([...tested.toolNames]), needsOAuth: tested.needsOAuth } });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "organization", entityId: organizationId });
  });
  loggerOf(deps).info("library.server.tested", { organizationId, itemId, kind: "mcp_server", sourceKind: "registry", tools: tested.toolNames.length, needsOAuth: tested.needsOAuth });
  return tested;
};

/** An organization admin's test call: the server's tools, or the OAuth mark, kept on its current version. */
export const testServer: TestServer = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin tests a library server");
  }
  return testCurrentVersion(deps, organizationId, input.itemId);
};
