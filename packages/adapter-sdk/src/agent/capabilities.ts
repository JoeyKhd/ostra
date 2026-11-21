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
  /**
   * Milestone 2 (ADR 0039, F-033): the agent exports a session to an archive and imports one into
   * another box's workspace (`exportSession`, `importSession`), so a fresh box carries the session on.
   */
  readonly sessionArchive: boolean;

  // ---- milestone 3 (ADR 0049) ----
  /**
   * Whether the agent's own settings can say "ask" for a path or a command, so it asks only for
   * what a rule covers (`native`), or it asks for every request and only the runner's check
   * stands (`runner-only`). The runner checks every request against the rules either way.
   */
  readonly permissionRules: "native" | "runner-only";
  /**
   * How the adapter makes a read-only plan turn (F-063): an ACP session mode it switches with
   * `session/set_mode` (`session-mode`), a relaunch with the other mode's launch and
   * `session/load` (`relaunch`), or not at all (`none`: plan first can't run on this agent).
   */
  readonly planMode: "session-mode" | "relaunch" | "none";
  /** The agent reads skills from a folder of the task's config; without it, they're appended to its instructions. */
  readonly skills: boolean;
  /** The MCP transports the agent speaks: an HTTP server at the sidecar's proxy, a stdio command in the image. */
  readonly mcp: { readonly http: boolean; readonly stdio: boolean };
  /**
   * The profile's permissions and MCP servers win over a repo's own agent config. Without it, the
   * runner hides the files `repoConfigPaths` names from the agent for the task (ADR 0049, Q171).
   */
  readonly projectConfigOverride: boolean;

  // ---- milestone 4 (ADR 0044, F-110) ----
  /**
   * How the agent takes project memory: it reaches ostra's MCP server and gets `memory_search`,
   * `memory_read` and `memory_propose` beside the block (`mcp`), or it can't, and gets the block
   * alone, the index and the "always" notes (`index-only`).
   */
  readonly memory: "mcp" | "index-only";

  // ---- milestone 4 (ADR 0066, F-137) ----
  /**
   * How the agent takes a reasoning level: an ACP session config option of category
   * `thought_level`, set with `session/set_config_option` after each session start and between
   * turns (`session-option`, OpenCode), a relaunch with the level's launch and `session/load`
   * (`relaunch`), or not at all (`none`: every task runs at the agent's default, and the panel
   * shows no control).
   */
  readonly reasoningEffort: "session-option" | "relaunch" | "none";

  // ---- subagents (2026-11-20, F-138's turn) ----
  /**
   * How the agent's subagents meet its turn. `background`: they run on after the agent's prompt is
   * answered, and the agent reports each one's state (OpenCode's child-session updates), so a turn
   * ends only once no subagent runs and the agent has finished the turns their reports wake it
   * for. `none`: the agent has no subagents ostra can tell apart, and a turn ends with its
   * prompt's answer.
   */
  readonly subagents: "background" | "none";

  // ---- milestone 9 (ADR 0070, F-148) ----
  /**
   * The agent takes images in its prompt and its steers, as ACP `image` blocks the model sees as
   * pictures. The driver also needs the agent to advertise `promptCapabilities.image` at
   * `initialize`, and the task's model to take images. Without all three, a message's images reach
   * the agent as files on disk, their paths in its prompt.
   */
  readonly promptImages: boolean;
};
