import type { Logger } from "@ostra/adapter-sdk";
import { createPanelStartAppTokens, PANEL_START_APP_PATH, PANEL_START_APP_TOKEN_TTL_MS, startAppAnswerSchema } from "@ostra/domain";
import type { StartAppAnswer } from "@ostra/domain";
import { parseJson } from "@ostra/protocol";
import type { MemberId, OrganizationId, TaskId } from "@ostra/protocol";

// "Start the app" from the panel (milestone 8, F-141, Q300, ADR 0068): core runs it, since core
// holds the agent adapters and makes every dispatch (`start-app-on-core.ts`), so the app's box
// restores the agent's session as a reopen's would. The panel has checked that the member can open
// the task; it asks core over core's own address (`OSTRA_CORE_INTERNAL_URL`) with a token for that
// member and that task, a minute long, under the secrets key both processes hold, and relays
// `startApp`'s answer. A core it can't reach, or that answers anything else, is `core-unreachable`:
// nothing started. Lines carry the task, never the token.

export type AppStartRequest = { readonly organizationId: OrganizationId; readonly memberId: MemberId; readonly taskId: TaskId };

/** Core's answer, or `core-unreachable` when core didn't give one. */
export type AppStartAnswer = StartAppAnswer | { readonly ok: false; readonly error: "core-unreachable"; readonly message: string };

/** Asks core to start a task's app for a member (`ApiDeps.appStart`). */
export type AppStarter = (request: AppStartRequest) => Promise<AppStartAnswer>;

export type CoreAppStarterOptions = {
  /** Core as the panel reaches it, without a trailing slash. */
  readonly coreUrl: string;
  /** The secrets key's text: the key both processes hold. */
  readonly secret: string;
  readonly logger: Logger;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
  /** How long core may take: past `startApp`'s own 30 s transaction. */
  readonly timeoutMs?: number;
};

const UNREACHABLE = { ok: false, error: "core-unreachable", message: "ostra's server can't be reached to start this task's app. Try again shortly." } as const;

export const coreAppStarter = (options: CoreAppStarterOptions): AppStarter => {
  const tokens = createPanelStartAppTokens(options.secret);
  const now = options.now ?? Date.now;
  const send = options.fetch ?? fetch;
  const logger = options.logger.child({ component: "core-app-start" });
  return async (request) => {
    const token = tokens.issue({ ...request, expiresAt: now() + PANEL_START_APP_TOKEN_TTL_MS });
    try {
      const response = await send(`${options.coreUrl}${PANEL_START_APP_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(options.timeoutMs ?? 40_000),
      });
      const json = parseJson(await response.text());
      const answer = response.ok && json.ok ? startAppAnswerSchema.safeParse(json.value) : undefined;
      if (answer?.success === true) {
        return answer.data;
      }
      logger.warn("app-start.core-refused", { taskId: request.taskId, status: response.status });
    } catch (error) {
      logger.warn("app-start.core-unreachable", { taskId: request.taskId, error: error instanceof Error ? error.name : "unknown" });
    }
    return UNREACHABLE;
  };
};
