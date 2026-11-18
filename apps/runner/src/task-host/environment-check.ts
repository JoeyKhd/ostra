import type { TaskCredentials } from "@ostra/protocol";

// The environment check (ticket 21, ADR 0030): before the agent starts, the task host looks at the
// environment its launch will get, and refuses to start it if any value holds a real credential:
// the model token, a git token, the runner's MCP token, or one of the environment's secrets. The
// agent gets the fake key and the proxy URLs; those are the only secrets-shaped values allowed.

/** Shorter secrets aren't searched for: a value like "1" would match half the environment. */
const MIN_SEARCHED_LENGTH = 8;

export type EnvironmentCheck = { readonly ok: true } | { readonly ok: false; readonly variable: string; readonly holds: string };

/** Every real credential value of the task, labelled by what it is (never by its value). */
export const credentialValues = (credentials: TaskCredentials): readonly { readonly label: string; readonly value: string }[] => [
  { label: "the model provider's token", value: credentials.model.token },
  { label: "the runner's MCP token", value: credentials.mcpToken },
  ...credentials.repos.map((repo) => ({ label: "a repo's git token", value: repo.gitToken })),
  ...credentials.secrets.flatMap((repo) =>
    repo.entries.flatMap((entry) =>
      entry.kind === "variable" ? [{ label: "an environment secret", value: entry.value }] : [{ label: "an environment secret file", value: entry.content }],
    ),
  ),
];

export const checkLaunchEnvironment = (env: Readonly<Record<string, string>>, credentials: TaskCredentials): EnvironmentCheck => {
  const secrets = credentialValues(credentials).filter((secret) => secret.value.length >= MIN_SEARCHED_LENGTH);
  for (const [name, value] of Object.entries(env)) {
    for (const secret of secrets) {
      if (value === secret.value || value.includes(secret.value)) {
        return { ok: false, variable: name, holds: secret.label };
      }
    }
  }
  return { ok: true };
};
