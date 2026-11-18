import { randomUUID } from "node:crypto";
import { buildPromptedPayload, makeWebhookRequest, signWebhook } from "../fake-linear/payloads.ts";
import type { WebhookRequest } from "../fake-linear/payloads.ts";
import { createInstantDriver } from "../turn-driver.ts";
import { until } from "../util.ts";
import { createRig, guarded, logText, readJson } from "./common.ts";
import type { Rig, ScenarioReport } from "./common.ts";

// Not a pass-bar bullet: the signed-webhook replays the task asks for, aimed at the handler's edges. Each one is a
// real HTTP request to the real server, signed (or deliberately not) the way Linear signs.

type Answer = { readonly status: number; readonly body: unknown };

const send = async (rig: Rig, request: WebhookRequest, method = "POST"): Promise<Answer> => {
  const response = await fetch(rig.webhookUrl, {
    method,
    headers: request.headers,
    ...(method === "POST" ? { body: request.rawBody } : {}),
  });
  return { status: response.status, body: await readJson(response) };
};

const statusOf = (answer: Answer): string => {
  const body = answer.body;
  if (typeof body === "object" && body !== null) {
    if ("status" in body && typeof body.status === "string") return body.status;
    if ("error" in body && typeof body.error === "string") return body.error;
  }
  return "";
};

export const runHardeningScenario = (): Promise<ScenarioReport> =>
  guarded("hardening", async (r) => {
    const driver = createInstantDriver();
    const rig = await createRig({ driver });
    try {
      await rig.install();
      const secret = rig.credentials.webhookSecret;
      const wrongSecret = "lin_wh_not_the_secret";

      // --- a good delegation, then every way to replay or damage it -----------------------
      const seeded = rig.fake.seedSession({ title: "Replay fixture", description: "Replay." });
      const created = makeWebhookRequest({ secret, payload: seeded.createdPayload() });
      const first = await send(rig, created);
      r.check("a correctly signed `created` is accepted", first.status === 200 && statusOf(first) === "accepted", `${String(first.status)} ${statusOf(first)}`);
      await until(() => rig.fake.session(seeded.sessionId)?.status === "complete", { timeoutMs: 5_000 });
      await rig.server.service.idle();
      const agentActivities = (): number => rig.fake.session(seeded.sessionId)?.activities.filter((a) => a.type !== "update").length ?? 0;
      const activitiesAfterFirst = agentActivities();
      r.check("it was answered (first thought, then the turn's response)", activitiesAfterFirst === 2, `${String(activitiesAfterFirst)} activities`);

      const again = await send(rig, created);
      r.check("the identical request replayed is acknowledged but not processed again", again.status === 200 && statusOf(again) === "duplicate");
      const redelivered = makeWebhookRequest({ secret, payload: seeded.createdPayload(), deliveryId: randomUUID() });
      const second = await send(rig, { rawBody: created.rawBody, headers: { ...created.headers, "linear-delivery": randomUUID() } });
      r.check("the same body under a new delivery ID is caught by its signature", second.status === 200 && statusOf(second) === "duplicate");
      const fresh = await send(rig, redelivered);
      r.check("a retry that Linear re-stamped (same session, new timestamp) does not start a second run", fresh.status === 200);
      await rig.server.service.idle();
      r.check("no replay added an activity", agentActivities() === activitiesAfterFirst, `${String(agentActivities())} activities`);
      r.check("and the turn ran once", driver.starts.filter((s) => s.request.sessionId === seeded.sessionId).length === 1);

      const other = rig.fake.seedSession();
      const otherPayload = other.createdPayload();
      const good = makeWebhookRequest({ secret, payload: otherPayload });
      const tampered: WebhookRequest = { rawBody: good.rawBody.replace("created", "creatEd"), headers: good.headers };
      const t = await send(rig, tampered);
      r.check("a body changed after signing is refused", t.status === 400 && statusOf(t) === "bad-signature", `${String(t.status)} ${statusOf(t)}`);
      const wrong = await send(rig, makeWebhookRequest({ secret: wrongSecret, payload: otherPayload }));
      r.check("a body signed with another secret is refused", wrong.status === 400 && statusOf(wrong) === "bad-signature");
      const withoutSignature = Object.fromEntries(Object.entries(good.headers).filter(([name]) => name !== "linear-signature"));
      const unsigned = await send(rig, { rawBody: good.rawBody, headers: withoutSignature });
      r.check("a request with no signature is refused", unsigned.status === 400 && statusOf(unsigned) === "missing-signature");
      const old = await send(rig, makeWebhookRequest({ secret, payload: { ...otherPayload, webhookTimestamp: Date.now() - 120_000 } }));
      r.check("a validly signed request older than a minute is refused", old.status === 400 && statusOf(old) === "bad-timestamp", `${String(old.status)} ${statusOf(old)}`);
      const future = await send(rig, makeWebhookRequest({ secret, payload: { ...otherPayload, webhookTimestamp: Date.now() + 120_000 } }));
      r.check("so is one stamped in the future", future.status === 400 && statusOf(future) === "bad-timestamp");
      const garbage = "{ not json";
      const malformed = await send(rig, { rawBody: garbage, headers: { ...good.headers, "linear-signature": signWebhook(secret, garbage) } });
      r.check("a signed body that is not JSON is refused", malformed.status === 400 && statusOf(malformed) === "malformed-body");
      r.check("none of those created a session on the server", rig.server.service.stateOf(other.sessionId) === undefined);

      // --- accepted, but nothing to do -----------------------------------------------------------
      const stamp = Date.now();
      const issueEvent = await send(rig, makeWebhookRequest({ secret, payload: { type: "Issue", action: "update", webhookTimestamp: stamp, data: { id: "x" } }, event: "Issue" }));
      r.check("another event type is acknowledged and ignored", issueEvent.status === 200 && statusOf(issueEvent) === "ignored");
      const noStamp = await send(rig, { rawBody: "[]", headers: { ...good.headers, "linear-signature": signWebhook(secret, "[]") } });
      r.check("a signed body with no timestamp is refused", noStamp.status === 400 && statusOf(noStamp) === "bad-timestamp", `${String(noStamp.status)} ${statusOf(noStamp)}`);
      const unknownAction = await send(rig, makeWebhookRequest({ secret, payload: { ...otherPayload, action: "somethingNew", webhookTimestamp: Date.now() } }));
      r.check("an agent-session action ostra does not know is acknowledged, not retried", unknownAction.status === 200 && statusOf(unknownAction) === "unparsed");
      const withExtras = rig.fake.seedSession();
      const extra = await send(rig, makeWebhookRequest({ secret, payload: { ...withExtras.createdPayload(), futureField: { nested: [1, 2, 3] } } }));
      r.check("fields Linear adds later are tolerated", extra.status === 200 && statusOf(extra) === "accepted");
      await until(() => (rig.fake.session(withExtras.sessionId)?.activities.length ?? 0) >= 1, { timeoutMs: 5_000 });

      // --- a follow-up in each of the two shapes the text may arrive in ----------------------------
      const followSession = rig.fake.seedSession();
      await send(rig, makeWebhookRequest({ secret, payload: followSession.createdPayload() }));
      await rig.server.service.idle();
      const view = rig.fake.session(followSession.sessionId);
      const appUser = rig.fake.appUser();
      if (view !== undefined && appUser !== undefined) {
        const common = {
          organizationId: rig.fake.organizationId,
          appUserId: appUser.id,
          oauthClientId: rig.credentials.clientId,
          sessionId: followSession.sessionId,
          issue: view.issue,
          creator: rig.fake.admin,
          now: Date.now(),
        };
        const prompted = buildPromptedPayload({ ...common, activityId: randomUUID(), body: "nested shape", stop: false });
        await send(rig, makeWebhookRequest({ secret, payload: prompted }));
        const flat = { ...prompted, webhookTimestamp: Date.now(), agentActivity: { id: randomUUID(), body: "flat shape", content: null } };
        await send(rig, makeWebhookRequest({ secret, payload: flat }));
        await rig.server.service.idle();
        const texts = driver.followUps.filter((f) => f.sessionId === followSession.sessionId).map((f) => f.text);
        r.check("a follow-up's text is read from `content.body` or from `body`", texts.includes("nested shape") && texts.includes("flat shape"), texts.join(" | "));
      }

      // --- the shape of the endpoint itself ----------------------------------------------------
      const get = await send(rig, created, "GET");
      r.check("GET on the webhook path is refused", get.status === 405);
      const big = makeWebhookRequest({ secret, payload: { type: "AgentSessionEvent", action: "created", webhookTimestamp: Date.now(), pad: "x".repeat(2 * 1024 * 1024) } });
      const huge = await send(rig, big);
      r.check("a 2 MiB body is refused before it is parsed", huge.status === 413, String(huge.status));
      const stranger = await fetch(`${rig.localOrigin}/nothing-here`);
      await stranger.arrayBuffer();
      r.check("any other path is a 404", stranger.status === 404);

      // --- a workspace ostra is not installed in ----------------------------------------------------
      const foreign = rig.fake.seedSession();
      const foreignPayload = { ...foreign.createdPayload(), organizationId: "org-not-installed" };
      const foreignAnswer = await send(rig, makeWebhookRequest({ secret, payload: foreignPayload }));
      await rig.server.service.idle();
      r.check("an event for a workspace with no installation is acknowledged, and the server carries on", foreignAnswer.status === 200 && (await fetch(`${rig.localOrigin}/healthz`).then((h) => h.status)) === 200);
      r.check("and nothing was posted for it", (rig.fake.session(foreign.sessionId)?.activities.length ?? 0) === 0);

      const text = logText(rig.logs);
      r.check("no secret reached a log line during any of it", !text.includes(secret) && !text.includes(wrongSecret));
      const stats = rig.server.stats();
      r.note(`Server counters: ${String(stats.accepted)} accepted, ${String(stats.duplicates)} duplicates, ${String(stats.ignored)} ignored, ${String(stats.unparsed)} unparsed, rejected ${JSON.stringify(stats.rejected)}.`);
    } finally {
      await rig.close();
    }
  });
