import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { readMail } from "@ostra/adapter-email-smtp/read-mail";

import { defaultMailDir } from "./mail-sink.ts";

// The mail box helper (milestone 4, ticket 40; spec section 8): reads the newest mail the dev mail
// sink wrote to an address, and returns its subject and its links, for the end-to-end demo to open
// an invitation, a verification or a reset link the way the person would.

export type SunkMail = {
  readonly file: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Every `http(s)` link in the text part, then the HTML's `href`s, each once, in order. */
  readonly links: readonly string[];
};

const linksOf = (text: string, html: string): readonly string[] => {
  const found = [
    ...[...text.matchAll(/https?:\/\/[^\s<>"')]+/g)].map((match) => match[0]),
    ...[...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((match) => (match[1] ?? "").replaceAll("&amp;", "&")),
  ];
  return [...new Set(found.filter((link) => link !== ""))];
};

/** The addresses of a message's `To:` header, in lower case. */
const recipientsOf = (header: string): readonly string[] =>
  header
    .split(",")
    .map((part) => (/<([^>]+)>/.exec(part)?.[1] ?? part).trim().toLowerCase())
    .filter((address) => address !== "");

/** The newest mail to an address in the sink's folder, or `null` when there is none. */
export const newestMailTo = async (address: string, dir: string = defaultMailDir): Promise<SunkMail | null> => {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".eml"));
  } catch {
    return null;
  }
  const wanted = address.trim().toLowerCase();
  // The names start with the time the sink took them, so the newest sorts last.
  for (const name of files.sort().reverse()) {
    const file = path.join(dir, name);
    const mail = readMail(await readFile(file, "utf8"));
    if (recipientsOf(mail.headers["to"] ?? "").includes(wanted)) {
      return { file, to: wanted, subject: mail.subject, text: mail.text, html: mail.html, links: linksOf(mail.text, mail.html) };
    }
  }
  return null;
};
