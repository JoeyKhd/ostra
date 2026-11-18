import messages from "../../messages/en.json";

// Every string of the panel lives in `messages/en.json` (F-083), read through `t`. A key that's
// missing from the file fails the typecheck. English only in v1; another language is another file
// of the same shape.

export type Messages = typeof messages;

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

/** A dotted path to one string of `en.json`, such as `"signIn.title"`. */
export type MessageKey = Leaves<Messages>;

export type MessageParams = Readonly<Record<string, string | number>>;

const lookup = (key: string): string => {
  let node: unknown = messages;
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || node === null) return key;
    node = Reflect.get(node, segment);
  }
  return typeof node === "string" ? node : key;
};

/** The English string for `key`, with `{name}` placeholders filled from `params`. */
export const t = (key: MessageKey, params?: MessageParams): string => {
  const text = lookup(key);
  if (params === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
};

/** `n` with the singular or plural form of a key pair (`<key>.one`, `<key>.other`). */
export const plural = (
  n: number,
  one: MessageKey,
  other: MessageKey,
  params: MessageParams = {},
): string => t(n === 1 ? one : other, { ...params, n });
