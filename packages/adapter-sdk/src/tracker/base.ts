import type { TicketKey } from "@ostra/protocol";

import { createPlumbing, defaultAdapterContext } from "../common/context.ts";
import type { AdapterContext, Plumbing } from "../common/context.ts";
import type { AdapterResult, HealthReport } from "../common/result.ts";
import type { TrackerCapabilities } from "./capabilities.ts";

// The tracker kind (ADR 0013, ADR 0025): Linear first, then Jira, GitHub Issues, GitLab. Every
// operation is declared now; Linear implements them in milestone 2. ostra keeps references and a
// cached copy of tickets, never the source of truth.

/** The board a ticket lives on, as the tracker names it. */
export type BoardRef = { readonly externalId: string };

export type TicketStatus = { readonly id: string; readonly name: string };

/** A ticket, as every tracker adapter returns it. */
export type Ticket = {
  readonly key: TicketKey;
  readonly title: string;
  /** Markdown. Untrusted text: passed as data, never interpolated into a command. */
  readonly description: string | null;
  readonly status: TicketStatus;
  readonly url: string;
  /** Lower is more urgent; `null` when the tracker has none. */
  readonly priority: number | null;
  readonly parentKey: TicketKey | null;
  readonly updatedAt: number;
};

export type TicketQuery = {
  readonly board: BoardRef;
  readonly statusIds?: readonly string[];
  readonly updatedSince?: number;
  readonly cursor?: string;
};

export type TicketPage = { readonly tickets: readonly Ticket[]; readonly nextCursor: string | null };

export abstract class TrackerAdapter {
  readonly kind = "tracker" as const;
  abstract readonly name: string;
  abstract readonly capabilities: TrackerCapabilities;

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

  /** Whether the tracker answers with the adapter's credentials. */
  abstract health(): Promise<HealthReport>;

  /** One ticket by key. Milestone 2. */
  abstract getTicket(board: BoardRef, key: TicketKey): Promise<AdapterResult<Ticket>>;

  /** A page of a board's tickets. Milestone 2. */
  abstract listTickets(query: TicketQuery): Promise<AdapterResult<TicketPage>>;

  /** Moves a ticket to a status (F-031). Milestone 2. */
  abstract updateStatus(board: BoardRef, key: TicketKey, statusId: string): Promise<AdapterResult<void>>;

  /** Adds a comment, written by ostra. Milestone 2. */
  abstract comment(board: BoardRef, key: TicketKey, markdown: string): Promise<AdapterResult<{ readonly commentId: string }>>;

  /** Links a PR to a ticket. Milestone 2. */
  abstract linkPullRequest(board: BoardRef, key: TicketKey, pullRequestUrl: string): Promise<AdapterResult<void>>;
}
