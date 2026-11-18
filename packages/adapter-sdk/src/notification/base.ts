import type { MemberId, OrganizationId } from "@ostra/protocol";

import { createPlumbing, defaultAdapterContext } from "../common/context.ts";
import type { AdapterContext, Plumbing } from "../common/context.ts";
import type { AdapterResult, HealthReport } from "../common/result.ts";
import type { NotificationCapabilities } from "./capabilities.ts";

// The notification kind (ADR 0025): the panel, Linear and email in v1, Slack later. Declared now;
// the first adapters come in milestone 3.

export type Notification = {
  readonly organizationId: OrganizationId;
  readonly memberIds: readonly MemberId[];
  readonly title: string;
  readonly body: string;
  /** The panel's page it's about. */
  readonly url: string;
  /** Sends at most once per key (ADR 0011). */
  readonly idempotencyKey: string;
};

export abstract class NotificationAdapter {
  readonly kind = "notification" as const;
  abstract readonly name: string;
  abstract readonly capabilities: NotificationCapabilities;

  readonly #context: AdapterContext;
  #plumbing: Plumbing | undefined;

  constructor(context: AdapterContext = defaultAdapterContext) {
    this.#context = context;
  }

  /** Retries, rate budgets, idempotency and the logger, shared by every adapter (ADR 0025). */
  protected get plumbing(): Plumbing {
    this.#plumbing ??= createPlumbing(this.#context, { kind: this.kind, name: this.name });
    return this.#plumbing;
  }

  abstract health(): Promise<HealthReport>;

  /** Delivers one notification on this adapter's channel. Milestone 3. */
  abstract send(notification: Notification): Promise<AdapterResult<void>>;
}
