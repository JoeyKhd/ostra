// What the agent may do without asking, written into its OpenCode config for
// every run. It follows ADR 0031: ostra sets every agent's permissions and
// never relies on an agent's defaults, and a profile's approval rules name
// what needs a person, "for example a new dependency". So the agent may read,
// edit and run commands in its workspace, and asks before it installs a
// package. Nobody answers in this spike: each request is allowed once and
// counted, so the record says how often a member would have been pinged.
//
// An agent's reach ends at its task's workspace (AGENTS.md), so OpenCode's file
// tools may not leave it. With `allow *` alone they read and write anywhere the
// member's account can (checked against OpenCode 2.3.2, and checked again by
// every `pnpm spike`: one run writes and reads outside its workspace under
// these rules and is refused, and a control run under `allow *` alone is not).
// The shell tool is not covered by this rule: on a host run it reaches whatever
// the member's account does, which includes ~/.config/ostra-dev/ and this
// spike's hidden tests. Only a box (spike 3) closes that.

import type { PermissionRule } from "../lib/opencode.ts";

export const POLICY_NAME = "workspace-only-installs-ask";

/**
 * What asks: a command that fetches code and puts it on the machine or runs it
 * (a package manager's install and update, and the runners that download a
 * package to execute it). These are the only approvals this policy produces, so
 * the record's approval count is the number of times a member would have been
 * asked before a new dependency or a downloaded tool.
 */
const INSTALL_COMMANDS = [
  "npm install*",
  "npm i *",
  "npm add*",
  "npm ci*",
  "npm update*",
  "npm upgrade*",
  "npm exec*",
  "npx *",
  "pnpm add*",
  "pnpm install*",
  "pnpm i *",
  "pnpm update*",
  "pnpm dlx*",
  "pnpm exec*",
  "yarn add*",
  "yarn install*",
  "yarn dlx*",
  "bun add*",
  "bun install*",
  "bunx *",
  "pip install*",
  "pip3 install*",
] as const;

/** The name a run's record carries when a check overrides the permission rules (a control run), so it is never mistaken for the policy. */
export const CONTROL_POLICY_NAME = "control-allow-everything";

export const PERMISSION_RULES: readonly PermissionRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "deny" },
  ...INSTALL_COMMANDS.map((resource) => ({ action: "shell", resource, effect: "ask" }) satisfies PermissionRule),
];

/** What a control run runs under: `allow *` and nothing else, to show what the rules above prevent. Never a policy for real work. */
export const ALLOW_EVERYTHING_RULES: readonly PermissionRule[] = [{ action: "*", resource: "*", effect: "allow" }];
