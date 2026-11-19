/**
 * A same-site path to return to after sign-in; anything else goes Home. A plain module, not the
 * client form's, so the server pages can call it too.
 */
export const safeNext = (next: string | null): string =>
  next !== null && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/";
