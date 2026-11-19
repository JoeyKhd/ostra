// The CLI's command lines as the panel prints them. Until the CLI ships on npm (ADR 0046) a member
// runs it from a clone of ostra, so every line starts with the same prefix: the Runners page's
// connect line, Account's login line and take it local's login hint always agree.

export const CLI_PREFIX = "pnpm ostra";

/** `pnpm ostra login --server https://…`. */
export const cliLine = (args: string): string => `${CLI_PREFIX} ${args}`;
