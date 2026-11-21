import {
  checkViewInput,
  closeView,
  closeViewInTx,
  createPreviewLink,
  heartbeatView,
  listPreviews,
  openView,
  previewLinkTokenHash,
  previewShownInTx,
  previewViewInTx,
  resolvePreviewLinkInTx,
  revokePreviewLink,
  setPreviewLevel,
  takeMemberScreenshot,
  usePreviewLink,
} from "@ostra/domain";
import type { MemberScope, PreviewLinkResolution, PreviewViewRow } from "@ostra/domain";
import {
  appPathSchema,
  memberIdSchema,
  previewKeySchema,
  previewLinkIdSchema,
  previewViewIdSchema,
  previewViewportSchema,
  projectIdSchema,
  taskIdSchema,
  viewportPresetSchema,
} from "@ostra/protocol";
import type { PreviewViewId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { previewLinkMisses, previewLinkOpens } from "../services/preview-link-tries.ts";
import { clientAddressOf } from "../services/rate-limit.ts";
import type { ApiDeps, Context } from "../trpc/context.ts";
import { memberProcedure, publicProcedure, router, taskProcedure } from "../trpc/init.ts";

// Milestone 8, ticket 20 (F-141, F-142, ADR 0068): a task's previews in the pane, its views, "Start
// the app", a member's screenshot, and sharing: a preview's level, its links, and the viewer page's
// own procedures for someone with a link.
//
// - A member who can open the task lists its previews, opens and closes views, keeps them warm,
//   starts the app, takes a screenshot and shares a preview. Another organization's task, and one in
//   a restricted project they can't open, are NOT_FOUND.
// - A named person (a member the preview's level names, who can't open the project) gets
//   `previews.open` for that preview alone, and the heartbeat and close of their own view. Every
//   other procedure of the task refuses them as it refuses anyone outside the project.
// - Someone with a link reaches only `previews.link.*`, with the link's token: the viewer page's
//   open, heartbeat and close. Tries are limited by address. An unknown token never says whether it
//   existed.
//
// Every refusal a person can act on comes as a code (`reason`) the panel words through `t`, never
// as task content. Never logged: a link's token.

/** Why a view didn't open, for a member: the pane's words come from it. */
const openRefusalSchema = z.enum(["no-box", "port-not-allowed", "runner-needs-upgrade", "runner-cannot-preview", "level-unknown"]);

/** Why "Start the app" didn't. `core-unreachable`: the panel couldn't ask core, and nothing started. */
const startRefusalSchema = z.enum(["no-app-processes", "no-runner", "runner-needs-upgrade", "runner-cannot-preview", "forbidden", "core-unreachable"]);

/** Why a member's screenshot wasn't asked for. */
const screenshotRefusalSchema = z.enum(["no-box", "port-not-allowed", "runner-needs-upgrade", "runner-cannot-preview"]);

const viewStateSchema = z.enum(["opening", "open", "closed"]);

/** The viewer page's data (`preview-viewer.md`, "Data it needs"): nothing else of the task. */
const shownSchema = { label: z.string(), port: z.number().int().nullable(), organizationName: z.string() };
export const previewViewerPageSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("live"), viewId: previewViewIdSchema, ...shownSchema, expiresAt: z.number().int().nullable(), input: z.boolean() }),
  /** The box isn't running, or the preview is gone from it: the page picks it up again by itself. */
  z.strictObject({ state: z.literal("not-running"), ...shownSchema, expiresAt: z.number().int().nullable(), input: z.boolean() }),
  /** The task's runner can't show a preview: the page names no runner and no version. */
  z.strictObject({ state: z.literal("runner-too-old"), organizationName: z.string() }),
  z.strictObject({ state: z.literal("expired"), ...shownSchema, at: z.number().int() }),
  z.strictObject({ state: z.literal("revoked"), ...shownSchema, at: z.number().int() }),
  /** A public link where the organization no longer allows them. */
  z.strictObject({ state: z.literal("not-allowed"), organizationName: z.string() }),
  z.strictObject({ state: z.literal("unknown") }),
]);
export type PreviewViewerPage = z.infer<typeof previewViewerPageSchema>;

/** What the viewer page's heartbeat and close see: the view's state, or why the link opens nothing now. */
const linkViewStateSchema = z.strictObject({ state: z.enum(["opening", "open", "closed", "expired", "revoked", "not-allowed", "unknown"]) });

const tokenSchema = z.string().min(1).max(256);

const viewDeps = (deps: ApiDeps) => ({
  db: deps.db,
  outbox: deps.ports.outbox,
  notices: deps.ports.notices,
  clock: deps.ports.clock,
  settings: deps.settings.previews,
  panelTokens: deps.previews.panelTokens,
});

const sharingDeps = (deps: ApiDeps) => ({
  db: deps.db,
  outbox: deps.ports.outbox,
  notices: deps.ports.notices,
  audit: deps.ports.audit,
  clock: deps.ports.clock,
  settings: deps.settings.previews,
  logger: deps.logger,
});

const notFound = (what: string): TRPCError => new TRPCError({ code: "NOT_FOUND", message: `No such ${what}` });

/** A member's own view, inside their organization: someone else's is NOT_FOUND. */
const ownViewOf = async (ctx: { readonly deps: ApiDeps; readonly scope: MemberScope }, viewId: PreviewViewId): Promise<PreviewViewRow> => {
  const view = await previewViewInTx(ctx.deps.db, viewId);
  if (view?.organizationId !== ctx.scope.organizationId || view.viewer.kind !== "member" || view.viewer.memberId !== ctx.scope.memberId) {
    throw notFound("view");
  }
  return view;
};

/**
 * A view's heartbeat (Q299), after its viewer's access is read again: a viewer who may no longer
 * watch (a link revoked, a name taken off the level, a project left) has the view closed now.
 */
const beat = async (deps: ApiDeps, viewId: PreviewViewId): Promise<z.infer<typeof viewStateSchema>> => {
  const access = await checkViewInput(deps.db, viewId, deps.ports.clock.now());
  if (!access.ok && access.reason !== "watch-only") {
    if (access.reason !== "not-found" && access.reason !== "closed") {
      await deps.db.$transaction((tx) => closeViewInTx(deps.ports, tx, { viewId, reason: "refused" }));
    }
    return "closed";
  }
  const result = await heartbeatView(viewDeps(deps), { viewId });
  if (!result.ok) {
    return "closed";
  }
  return result.open ? "open" : "opening";
};

// ---------- someone with a link ----------

/** One more try of a token from the request's address: refused while the address spent its misses. */
const linkTry = (ctx: Context): string => {
  const address = clientAddressOf(ctx.headers);
  if (previewLinkMisses.blocked(address, ctx.deps.ports.clock.now())) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many tries: wait a minute" });
  }
  return address;
};

const missed = (ctx: Context, address: string): void => {
  previewLinkMisses.fail(address, ctx.deps.ports.clock.now());
};

/**
 * The viewer page's open (`/p/<token>`, ADR 0068): the link by its token's hash, its expiry, its
 * revoke and the organization's switch; its first use audited once; then a view for the link. The
 * page gets the preview's label and port, the organization's name, the expiry and whether input is
 * allowed, and nothing else of the task.
 */
export const openLinkViewer = async (ctx: Context, input: { readonly token: string; readonly viewport: z.infer<typeof previewViewportSchema> | null }): Promise<PreviewViewerPage> => {
  const address = linkTry(ctx);
  if (!previewLinkOpens.allow(address, ctx.deps.ports.clock.now())) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many tries: wait a minute" });
  }
  const used = await usePreviewLink(sharingDeps(ctx.deps), { token: input.token });
  switch (used.state) {
    case "unknown":
      missed(ctx, address);
      return { state: "unknown" };
    case "expired":
    case "revoked":
      return { state: used.state, label: used.label, port: used.port, organizationName: used.organizationName, at: used.at };
    case "not-allowed":
      return { state: "not-allowed", organizationName: used.organizationName };
    case "active":
      break;
    default:
      return used satisfies never;
  }
  const shown = { label: used.label, port: used.port, organizationName: used.organizationName, expiresAt: used.expiresAt, input: used.input };
  const opened = await openView(viewDeps(ctx.deps), { kind: "link", token: input.token }, { taskId: used.taskId, key: used.key, mode: "stream", viewport: input.viewport });
  if (opened.ok) {
    return { state: "live", viewId: opened.viewId, ...shown, input: opened.input };
  }
  switch (opened.error) {
    case "no-box":
    case "port-not-allowed":
    case "not-found":
      return { state: "not-running", ...shown };
    case "runner-needs-upgrade":
    case "runner-cannot-preview":
      return { state: "runner-too-old", organizationName: used.organizationName };
    // The link ended between the two reads.
    case "link-expired":
    case "link-revoked":
    case "public-links-off":
    case "link-unknown":
    case "not-allowed":
    case "level-unknown":
      return (await openLinkAgain(ctx, input.token)) ?? { state: "unknown" };
    default:
      return opened.error satisfies never;
  }
};

/** The link's state again, after a race with its end. */
const openLinkAgain = async (ctx: Context, token: string): Promise<PreviewViewerPage | null> => {
  const again = await ctx.deps.db.$transaction((tx) => resolvePreviewLinkInTx(tx, token, ctx.deps.ports.clock.now()));
  switch (again.state) {
    case "expired":
    case "revoked":
      return { state: again.state, label: again.label, port: again.port, organizationName: again.organizationName, at: again.at };
    case "not-allowed":
      return { state: "not-allowed", organizationName: again.organizationName };
    case "active":
    case "unknown":
      return null;
    default:
      return again satisfies never;
  }
};

/**
 * The link's own view, for its heartbeat and close: the link must still open something, and the view
 * must be its own. A link that ended has its view closed now, and says why.
 */
const linkView = async (
  ctx: Context,
  token: string,
  viewId: PreviewViewId,
): Promise<{ readonly ok: true; readonly view: PreviewViewRow } | { readonly ok: false; readonly state: z.infer<typeof linkViewStateSchema>["state"] }> => {
  const address = linkTry(ctx);
  const deps = ctx.deps;
  const resolved: PreviewLinkResolution = await deps.db.$transaction((tx) => resolvePreviewLinkInTx(tx, token, deps.ports.clock.now()));
  if (resolved.state === "unknown") {
    missed(ctx, address);
    return { ok: false, state: "unknown" };
  }
  // The token's own link (its hash matched above), and whether the view is one it opened.
  const hash = previewLinkTokenHash(token);
  const link = hash === null ? null : await deps.db.previewLink.findUnique({ where: { tokenHash: hash }, select: { id: true } });
  const view = await previewViewInTx(deps.db, viewId);
  const owns = link !== null && view?.viewer.kind === "link" && view.viewer.linkId === link.id;
  switch (resolved.state) {
    case "expired":
    case "revoked":
    case "not-allowed":
      // Its views end with it, at once, rather than at the next sweep.
      if (owns && view.lifecycle.state !== "closed") {
        await deps.db.$transaction((tx) => closeViewInTx(deps.ports, tx, { viewId, reason: "link-ended" }));
      }
      return { ok: false, state: resolved.state };
    case "active":
      if (!owns) {
        // Another link's view, or none: the same answer as an unknown token.
        missed(ctx, address);
        return { ok: false, state: "unknown" };
      }
      return { ok: true, view };
    default:
      return resolved satisfies never;
  }
};

const linkRouter = router({
  /** The viewer page's open. Its server side calls it too, with the request's address. */
  open: publicProcedure
    .input(z.strictObject({ token: tokenSchema, viewport: previewViewportSchema.nullable().optional() }))
    .output(previewViewerPageSchema)
    .mutation(({ ctx, input }) => openLinkViewer(ctx, { token: input.token, viewport: input.viewport ?? null })),

  /** The viewer page's heartbeat, every 30 s while it's open and visible: it keeps the box warm (Q299). */
  heartbeat: publicProcedure
    .input(z.strictObject({ token: tokenSchema, viewId: previewViewIdSchema }))
    .output(linkViewStateSchema)
    .mutation(async ({ ctx, input }) => {
      const found = await linkView(ctx, input.token, input.viewId);
      if (!found.ok) {
        return { state: found.state };
      }
      return { state: await beat(ctx.deps, input.viewId) };
    }),

  /** The viewer page closed. */
  close: publicProcedure
    .input(z.strictObject({ token: tokenSchema, viewId: previewViewIdSchema }))
    .output(linkViewStateSchema)
    .mutation(async ({ ctx, input }) => {
      const found = await linkView(ctx, input.token, input.viewId);
      if (!found.ok) {
        return { state: found.state };
      }
      await closeView(viewDeps(ctx.deps), { viewId: input.viewId, reason: "closed" });
      return { state: "closed" as const };
    }),
});

// ---------- the router ----------

const taskInput = z.strictObject({ taskId: taskIdSchema });

export const previewsRouter = router({
  /**
   * The pane's list (F-141): the task's previews, primary first, each with its level, its named
   * people, its links (never a token) and how many watch it; the box's state and what it can show,
   * or why not; the last screenshot; and whether the organization allows public links.
   */
  list: taskProcedure("read", taskInput).query(async ({ ctx, input }) => {
    const listed = await listPreviews(sharingDeps(ctx.deps), ctx.scope, input);
    if (!listed.ok) {
      throw notFound("task");
    }
    return {
      previews: listed.previews,
      box: listed.box,
      can: listed.can,
      carrier: listed.carrier,
      lastScreenshot: listed.lastScreenshot,
      publicLinks: listed.publicLinks,
      linkMaxDays: listed.linkMaxDays,
    };
  }),

  /**
   * Opens a view of one preview (F-141): the browser view, its frames at
   * `/api/previews/<viewId>/stream` and its input at `/input`. A member who can open the task, or a
   * person the preview's level names (watch-only). Anyone else gets NOT_FOUND: whether the task
   * exists doesn't leak.
   */
  open: memberProcedure
    .input(z.strictObject({ taskId: taskIdSchema, key: previewKeySchema, viewport: previewViewportSchema.nullable().optional() }))
    .output(
      z.discriminatedUnion("ok", [
        z.strictObject({ ok: z.literal(true), viewId: previewViewIdSchema, input: z.boolean(), label: z.string(), port: z.number().int().nullable() }),
        z.strictObject({ ok: z.literal(false), reason: openRefusalSchema }),
      ]),
    )
    .mutation(async ({ ctx, input }) => {
      const opened = await openView(viewDeps(ctx.deps), { kind: "member", scope: ctx.scope }, { taskId: input.taskId, key: input.key, mode: "stream", viewport: input.viewport ?? null });
      if (!opened.ok) {
        switch (opened.error) {
          case "not-found":
          case "not-allowed":
          case "link-expired":
          case "link-revoked":
          case "public-links-off":
          case "link-unknown":
            throw notFound("preview");
          case "no-box":
          case "port-not-allowed":
          case "runner-needs-upgrade":
          case "runner-cannot-preview":
          case "level-unknown":
            return { ok: false as const, reason: opened.error };
          default:
            return opened.error satisfies never;
        }
      }
      const task = await ctx.deps.db.task.findFirst({ where: { id: input.taskId, organizationId: ctx.scope.organizationId }, select: { projectId: true } });
      const shown =
        task === null
          ? { label: input.key, port: null }
          : await ctx.deps.db.$transaction((tx) =>
              previewShownInTx(tx, { id: input.taskId, organizationId: ctx.scope.organizationId, projectId: projectIdSchema.parse(task.projectId) }, input.key),
            );
      return { ok: true as const, viewId: opened.viewId, input: opened.input, ...shown };
    }),

  /** The pane's heartbeat on its own view, every 30 s while it's open and the tab visible (Q299). */
  heartbeat: memberProcedure
    .input(z.strictObject({ viewId: previewViewIdSchema }))
    .output(z.strictObject({ state: viewStateSchema }))
    .mutation(async ({ ctx, input }) => {
      await ownViewOf(ctx, input.viewId);
      return { state: await beat(ctx.deps, input.viewId) };
    }),

  /** Closes the member's own view. Only its viewer may: `closeView` checks no caller. */
  close: memberProcedure
    .input(z.strictObject({ viewId: previewViewIdSchema }))
    .output(z.strictObject({ closed: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ownViewOf(ctx, input.viewId);
      const closed = await closeView(viewDeps(ctx.deps), { viewId: input.viewId, reason: "closed" });
      return { closed: closed.ok && closed.closed };
    }),

  /**
   * "Start the app" (Q300): a box for the app alone, with no agent turn, for any member who can open
   * the task; or `app.start` in the box that still runs. Admitted now or not at all. Core runs it
   * (`ApiDeps.appStart`), with every dispatch's settings, so the box restores the agent's session.
   */
  startApp: taskProcedure("read", taskInput)
    .output(
      z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true), state: z.enum(["starting", "running"]) }), z.strictObject({ ok: z.literal(false), reason: startRefusalSchema })]),
    )
    .mutation(async ({ ctx, input }) => {
      const started = await ctx.deps.appStart({ organizationId: ctx.scope.organizationId, memberId: ctx.scope.memberId, taskId: input.taskId });
      if (started.ok) {
        return { ok: true as const, state: started.state };
      }
      const { error } = started;
      switch (error) {
        case "not-found":
          throw notFound("task");
        case "forbidden":
        case "no-app-processes":
        case "no-runner":
        case "runner-needs-upgrade":
        case "runner-cannot-preview":
        case "core-unreachable":
          return { ok: false as const, reason: error };
        default:
          return error satisfies never;
      }
    }),

  /** "Take a screenshot" (F-121): the box takes one of the preview, and it lands in the thread. */
  takeScreenshot: taskProcedure("read", z.strictObject({ taskId: taskIdSchema, key: previewKeySchema, path: appPathSchema, width: viewportPresetSchema }))
    .output(z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true), requestId: z.string() }), z.strictObject({ ok: z.literal(false), reason: screenshotRefusalSchema })]))
    .mutation(async ({ ctx, input }) => {
      const taken = await takeMemberScreenshot(sharingDeps(ctx.deps), ctx.scope, input);
      if (taken.ok) {
        return { ok: true as const, requestId: taken.requestId };
      }
      switch (taken.error) {
        case "not-found":
        case "forbidden":
          throw notFound("task");
        case "no-box":
        case "port-not-allowed":
        case "runner-needs-upgrade":
        case "runner-cannot-preview":
          return { ok: false as const, reason: taken.error };
        default:
          return taken.error satisfies never;
      }
    }),

  /**
   * A preview's level below its links (F-142): the project's members, or named people. Choosing one
   * ends the preview's active links, and every view of someone who no longer qualifies.
   */
  setLevel: taskProcedure(
    "read",
    z.strictObject({ taskId: taskIdSchema, key: previewKeySchema, level: z.enum(["members", "named"]), memberIds: z.array(memberIdSchema).max(100) }),
  )
    .output(
      z.discriminatedUnion("ok", [
        z.strictObject({ ok: z.literal(true), level: z.enum(["members", "named"]), linksEnded: z.number().int(), viewsClosed: z.number().int() }),
        z.strictObject({ ok: z.literal(false), reason: z.enum(["not-a-member"]) }),
      ]),
    )
    .mutation(async ({ ctx, input }) => {
      const set = await setPreviewLevel(sharingDeps(ctx.deps), ctx.scope, input);
      if (set.ok) {
        return { ok: true as const, level: set.level, linksEnded: set.linksEnded, viewsClosed: set.viewsClosed };
      }
      switch (set.error) {
        case "not-found":
        case "forbidden":
          throw notFound("preview");
        case "not-a-member":
          return { ok: false as const, reason: set.error };
        default:
          return set.error satisfies never;
      }
    }),

  /**
   * A new link to one preview (F-142): expiring (24 hours unless picked, up to
   * `OSTRA_PREVIEW_LINK_MAX_DAYS`), or public where the organization allows it; watch-only unless it
   * allows input. Its URL holds its token and is in this answer only: it's never shown again.
   */
  createLink: taskProcedure(
    "read",
    z.strictObject({
      taskId: taskIdSchema,
      key: previewKeySchema,
      kind: z.enum(["expiring", "public"]),
      allowInput: z.boolean(),
      expiresInHours: z.number().int().min(1).max(365 * 24).nullable(),
    }),
  )
    .output(
      z.discriminatedUnion("ok", [
        z.strictObject({ ok: z.literal(true), linkId: previewLinkIdSchema, url: z.string(), expiresAt: z.number().int().nullable() }),
        z.strictObject({ ok: z.literal(false), reason: z.enum(["public-links-off", "too-long"]) }),
      ]),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.kind === "public" && input.expiresInHours !== null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A public link doesn't expire" });
      }
      const created = await createPreviewLink(sharingDeps(ctx.deps), ctx.scope, input);
      if (created.ok) {
        return { ok: true as const, linkId: created.linkId, url: `${ctx.deps.settings.publicUrl.replace(/\/+$/, "")}/p/${created.token}`, expiresAt: created.expiresAt };
      }
      switch (created.error) {
        case "not-found":
        case "forbidden":
          throw notFound("preview");
        case "public-links-off":
        case "too-long":
          return { ok: false as const, reason: created.error };
        default:
          return created.error satisfies never;
      }
    }),

  /** Ends a link: any member who can open its task may. Its viewers' pages end at once. */
  revokeLink: memberProcedure
    .input(z.strictObject({ linkId: previewLinkIdSchema }))
    .output(z.strictObject({ revoked: z.boolean(), viewsClosed: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const revoked = await revokePreviewLink(sharingDeps(ctx.deps), ctx.scope, input);
      if (!revoked.ok) {
        throw notFound("link");
      }
      return { revoked: revoked.revoked, viewsClosed: revoked.viewsClosed };
    }),

  /** Someone with a link: the viewer page's own procedures, and no other. */
  link: linkRouter,
});
