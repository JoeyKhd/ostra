/** What an agent adapter can do (ADR 0025, ADR 0032). Optional abilities are declared, never assumed. */
export type AgentCapabilities = {
  /** A member's message can reach the agent mid-turn, without cancelling it (OpenCode can, ADR 0032). */
  readonly steerMidTurn: boolean;
  /** The agent can resume its own session (`session/load`) in place. */
  readonly sessionLoad: boolean;
  /** The agent reports its plan natively (OpenCode's `todowrite`), so `plan.updated` events come. */
  readonly nativePlan: boolean;
  /** A rejected tool call leaves the turn running, so the agent can try another way. */
  readonly rejectAndContinue: boolean;
  /** The agent asks questions through ACP's `elicitation.form`, so they reach ostra. */
  readonly elicitationForm: boolean;
  /** The agent takes a model base URL and a placeholder key, so the key proxy can sit in front (ADR 0030). */
  readonly modelBaseUrlAndPlaceholderKey: boolean;
};
