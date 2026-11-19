import { Fragment } from "react";
import type { ReactNode } from "react";

import { t } from "./messages";
import type { MessageKey } from "./messages";

/**
 * A message with some placeholders filled by elements (a repo name in mono, a link), the rest by
 * text: `{repo} is {n} commits behind {base}` with `repo` and `base` as `<code>`. The message's own
 * words stay in `en.json`; a placeholder with no value stays as written.
 */
export const tNodes = (key: MessageKey, params: Readonly<Record<string, ReactNode>>): ReactNode => fillNodes(t(key), params);

/** `fillNodes` on a message already looked up (a plural form, say). */
export const fillNodes = (text: string, params: Readonly<Record<string, ReactNode>>): ReactNode => {
  const parts = text.split(/(\{\w+\})/g);
  return parts.map((part, index) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    if (name === undefined || !(name in params)) return part === "" ? null : <Fragment key={index}>{part}</Fragment>;
    return <Fragment key={index}>{params[name]}</Fragment>;
  });
};
