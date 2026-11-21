import type { Db, Tx } from "@ostra/db";
import { organizationIdSchema, previewKeySchema } from "@ostra/protocol";
import type { OrganizationId, PreviewKey, PreviewViewId, TaskId, UserId } from "@ostra/protocol";
import { z } from "zod";

import type { MemberScope } from "../access.ts";
import type { AuditLog, Clock } from "../ports.ts";
import { previewDomainCheckSchema } from "./domain-check.ts";
import type { PreviewDomainCheck } from "./domain-check.ts";
import { PREVIEW_FRAMING_VALUE_MAX } from "./host.ts";
import type { PreviewFraming } from "./host.ts";

// The preview domain's state as the panel shows it (milestone 8, ticket 26, F-144; ADR 0068;
// `instance-preview-domain.md` and `preview-native.md`):
//
// - the check's last result, kept per install with the domain it ran on, when, and who ran it, so
//   Instance › Previews shows it again and the pane knows whether the native preview works. A
//   result for another domain than today's `OSTRA_PREVIEW_DOMAIN` counts as no result;
// - `nativePreviewOn`: the pane opens "in your browser" by default only when the domain is set and
//   its last check passed (the target's open point 3), so a half-set domain never shows members a
//   broken frame;
// - the framing header core's proxy replaced on a native view's answers, per preview, for the
//   pane's notice: the app's own header and its value, never a cookie or a body.
//
// Never logged: a header's value.

/** The check's answer once it ran: the `checked` state of `previewDomainCheckSchema`. */
export type PreviewDomainChecked = Extract<PreviewDomainCheck, { readonly state: "checked" }>;

/** The preview domain as the panel reads it: not set, set and never checked, or its last check. */
export type PreviewDomainStatus =
  | { readonly state: "not-set" }
  | { readonly state: "unchecked"; readonly domain: string }
  | {
      readonly state: "checked";
      readonly domain: string;
      readonly check: PreviewDomainChecked;
      /** Epoch ms. */
      readonly at: number;
      /** Who ran it, by name; `null` once that account is gone. */
      readonly byName: string | null;
      readonly passed: boolean;
    };

/** The domain's state: its last check, when it ran on this same domain. */
export const previewDomainStatus = async (db: Db | Tx, domain: string | null): Promise<PreviewDomainStatus> => {
  if (domain === null) {
    return { state: "not-set" };
  }
  const row = await db.instanceSetting.findUnique({
    where: { id: "instance" },
    select: { previewCheckDomain: true, previewCheck: true, previewCheckAt: true, previewCheckByUserId: true },
  });
  if (row?.previewCheckDomain !== domain || row.previewCheckAt === null) {
    return { state: "unchecked", domain };
  }
  const parsed = previewDomainCheckSchema.safeParse(row.previewCheck);
  if (!parsed.success || parsed.data.state !== "checked") {
    return { state: "unchecked", domain };
  }
  const check = parsed.data;
  const user = row.previewCheckByUserId === null ? null : await db.user.findUnique({ where: { id: row.previewCheckByUserId }, select: { name: true } });
  return { state: "checked", domain, check, at: row.previewCheckAt.getTime(), byName: user?.name ?? null, passed: check.passed };
};

/** Whether the native preview is on for this install: a domain set, and its last check passed. */
export const nativePreviewOn = (status: PreviewDomainStatus): boolean => status.state === "checked" && status.passed;

/**
 * Who ran a check: the instance admin on Instance › Previews, or core itself at its start, for a
 * one-machine install's `preview.localhost` (ADR 0068, 2026-11-21).
 */
export type PreviewCheckRunner = { readonly kind: "member"; readonly userId: UserId; readonly scope: MemberScope } | { readonly kind: "system" };

/**
 * Keeps a check's result for the install (ticket 26): the domain it ran on, its answer, when and by
 * whom, replacing the last; and an audit entry with whether it passed and no result text
 * (`instance-preview-domain.md`, "Data it needs" 5): in the instance admin's organization, or, for
 * core's own check at its start, in every organization as the system, since the domain is the
 * install's. `not-set` keeps nothing.
 */
export const savePreviewDomainCheck = async (
  deps: { readonly db: Db; readonly audit: AuditLog; readonly clock: Clock },
  by: PreviewCheckRunner,
  input: { readonly domain: string | null; readonly check: PreviewDomainCheck },
): Promise<PreviewDomainStatus> => {
  const { domain, check } = input;
  if (domain === null || check.state === "not-set") {
    return { state: "not-set" };
  }
  const at = new Date(check.at);
  await deps.db.$transaction(async (tx) => {
    const kept = { previewCheckDomain: domain, previewCheck: check, previewCheckAt: at, previewCheckByUserId: by.kind === "member" ? by.userId : null };
    await tx.instanceSetting.upsert({ where: { id: "instance" }, create: { id: "instance", ...kept }, update: kept });
    const audited =
      by.kind === "member"
        ? [{ organizationId: by.scope.organizationId, actor: { kind: "member" as const, id: by.scope.memberId } }]
        : (await tx.organization.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((organization) => ({ organizationId: organizationIdSchema.parse(organization.id), actor: { kind: "system" as const, id: null } }));
    for (const { organizationId, actor } of audited) {
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId: null,
        actor,
        action: "instance.preview_domain_checked",
        entity: "organization",
        entityId: organizationId,
        data: { passed: check.passed },
      });
    }
  });
  return previewDomainStatus(deps.db, domain);
};

// ---------- the framing report ----------

const framingHeaderSchema = z.enum(["x-frame-options", "frame-ancestors"]);

/**
 * Records the framing header core's proxy replaced on a native view's answers, the first time it
 * did (ticket 26): a view already holding one keeps it. Core calls it once per view.
 */
export const recordPreviewFraming = async (db: Db, viewId: PreviewViewId, framing: PreviewFraming): Promise<void> => {
  await db.previewView.updateMany({
    where: { id: viewId, mode: "native", framingHeader: null },
    data: { framingHeader: framing.header, framingValue: framing.value.slice(0, PREVIEW_FRAMING_VALUE_MAX) },
  });
};

/** Each of a task's previews' framing report: the newest native view of it that recorded one. */
export const previewFramingOf = async (db: Db | Tx, organizationId: OrganizationId, taskId: TaskId): Promise<ReadonlyMap<PreviewKey, PreviewFraming>> => {
  const rows = await db.previewView.findMany({
    where: { organizationId, taskId, mode: "native", framingHeader: { not: null } },
    orderBy: [{ openedAt: "desc" }, { id: "desc" }],
    select: { key: true, framingHeader: true, framingValue: true },
    take: 50,
  });
  const found = new Map<PreviewKey, PreviewFraming>();
  for (const row of rows) {
    const key = previewKeySchema.safeParse(row.key);
    const header = framingHeaderSchema.safeParse(row.framingHeader);
    if (!key.success || !header.success || found.has(key.data)) {
      continue;
    }
    found.set(key.data, { header: header.data, value: row.framingValue ?? "" });
  }
  return found;
};
