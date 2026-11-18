import { AsyncLocalStorage } from "node:async_hooks";
import type { UserId } from "../ids.ts";

// Without a mail server there is nowhere to send a link. better-auth hands the
// link to `sendResetPassword`; ostra's callback drops it in the sink of the
// request that asked for it, and the admin who asked gets it back to copy.
// A request with no sink (a visitor clicking "forgot password") gets nothing,
// which is Q54's rule: self-service reset exists only when mail is set.

export type ResetLink = {
  readonly userId: UserId;
  readonly url: string;
};

export type LinkSink = {
  reset: ResetLink | undefined;
};

const storage = new AsyncLocalStorage<LinkSink>();

export const currentLinkSink = (): LinkSink | undefined => storage.getStore();

export const collectLinks = async <T>(
  work: () => Promise<T>,
): Promise<{ readonly result: T; readonly links: LinkSink }> => {
  const links: LinkSink = { reset: undefined };
  const result = await storage.run(links, work);
  return { result, links };
};
