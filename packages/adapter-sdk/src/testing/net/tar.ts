// A tar archive in memory (ustar, 512-byte blocks), for the fake registries' layers and npm
// tarballs (ticket 06). Milestone 8 (ticket 02): also folders, symlinks, a pax header for a path
// or a link target over 100 bytes, and the global pax `comment` that `git archive` writes its
// commit in, so the fake GitHub serves a commit's tarball as GitHub does. Test and dev only.

export type TarEntry = {
  readonly name: string;
  readonly content: Buffer;
  readonly mode?: number;
  /** Default `file`. A folder and a symlink carry no content; a symlink has its `linkTarget`. */
  readonly type?: "file" | "directory" | "symlink";
  readonly linkTarget?: string;
};

const MTIME = Math.floor(Date.UTC(2026, 0, 1) / 1000);
const FLAGS = { file: "0", directory: "5", symlink: "2" } as const;

const header = (input: { readonly name: string; readonly size: number; readonly mode: number; readonly flag: string; readonly linkTarget: string }): Buffer => {
  const block = Buffer.alloc(512);
  // A field holds at most its width: a longer name or target is in the pax header before it.
  block.write(input.name, 0, 100, "utf8");
  block.write(`${input.mode.toString(8).padStart(7, "0")}\0`, 100, "latin1");
  block.write("0000000\0", 108, "latin1");
  block.write("0000000\0", 116, "latin1");
  block.write(`${input.size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  block.write(`${MTIME.toString(8).padStart(11, "0")}\0`, 136, "latin1");
  block.write("        ", 148, "latin1");
  block.write(input.flag, 156, "latin1");
  block.write(input.linkTarget, 157, 100, "utf8");
  block.write("ustar\u000000", 257, "latin1");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return block;
};

const pad = (size: number): Buffer => Buffer.alloc((512 - (size % 512)) % 512);

/** A pax record, `"<length> <key>=<value>\n"`, its length counting its own digits. */
const paxRecord = (key: string, value: string): string => {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body);
  while (Buffer.byteLength(`${String(length)}${body}`) !== length) {
    length = Buffer.byteLength(`${String(length)}${body}`);
  }
  return `${String(length)}${body}`;
};

const paxHeader = (flag: "x" | "g", name: string, records: readonly string[]): Buffer[] => {
  const body = Buffer.from(records.join(""), "utf8");
  return [header({ name, size: body.length, mode: 0o644, flag, linkTarget: "" }), body, pad(body.length)];
};

/** A tar of the entries, with `comment` as the archive's global pax comment when given. */
export const tarOf = (entries: readonly TarEntry[], options: { readonly comment?: string } = {}): Buffer => {
  const blocks: Buffer[] = [];
  if (options.comment !== undefined) {
    blocks.push(...paxHeader("g", "pax_global_header", [paxRecord("comment", options.comment)]));
  }
  for (const entry of entries) {
    const type = entry.type ?? "file";
    const linkTarget = entry.linkTarget ?? "";
    const records = [
      ...(Buffer.byteLength(entry.name) > 100 ? [paxRecord("path", entry.name)] : []),
      ...(Buffer.byteLength(linkTarget) > 100 ? [paxRecord("linkpath", linkTarget)] : []),
    ];
    if (records.length > 0) {
      blocks.push(...paxHeader("x", "PaxHeader", records));
    }
    const content = type === "file" ? entry.content : Buffer.alloc(0);
    blocks.push(header({ name: entry.name, size: content.length, mode: entry.mode ?? (type === "directory" ? 0o755 : 0o644), flag: FLAGS[type], linkTarget }), content, pad(content.length));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
};
