import { describe, expect, it } from "vitest";

import { tarOf } from "../testing/net/tar.ts";
import { readTar } from "./tar.ts";
import type { TarDecision, TarEntry } from "./tar.ts";

// Milestone 8 (ticket 02, F-145): the streaming tar reader GitHub's `readTree` unpacks a commit's
// tarball with, fed in small chunks so every header and body crosses a chunk's edge.

// eslint-disable-next-line func-style -- a generator can't be an arrow function
async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) {
    await Promise.resolve();
    yield bytes.subarray(at, at + size);
  }
}

const read = async (archive: Uint8Array, decide: (entry: TarEntry) => TarDecision = () => "read", chunk = 7) => {
  const entries: TarEntry[] = [];
  const contents = new Map<string, string>();
  const comments: string[] = [];
  const outcome = await readTar(chunked(archive, chunk), {
    entry: (entry) => {
      entries.push(entry);
      return decide(entry);
    },
    bytes: (entry, bytes) => contents.set(entry.path, new TextDecoder().decode(bytes)),
    comment: (comment) => comments.push(comment),
  });
  return { outcome, entries, contents, comments };
};

const longPath = `root/${"deep/".repeat(30)}SKILL.md`;
const archive = tarOf(
  [
    { name: "root/", content: Buffer.alloc(0), type: "directory" },
    { name: "root/SKILL.md", content: Buffer.from("# skill\n") },
    { name: "root/run.sh", content: Buffer.from("#!/bin/sh\necho hi\n"), mode: 0o775 },
    { name: "root/link.md", content: Buffer.alloc(0), type: "symlink", linkTarget: "SKILL.md" },
    { name: longPath, content: Buffer.from("# deep\n") },
    { name: "root/far", content: Buffer.alloc(0), type: "symlink", linkTarget: `${"../".repeat(40)}etc/passwd` },
    { name: "root/big.bin", content: Buffer.alloc(5000, 0x41) },
  ],
  { comment: "a".repeat(40) },
);

describe("the tar reader", () => {
  it("F-145: reads files, folders, links, pax long names and the global comment, across chunk edges", async () => {
    const { outcome, entries, contents, comments } = await read(archive);
    expect(outcome).toEqual({ ok: true, value: "ended" });
    expect(comments).toEqual(["a".repeat(40)]);
    expect(entries.map((entry) => [entry.path, entry.type])).toEqual([
      ["root/", "directory"],
      ["root/SKILL.md", "file"],
      ["root/run.sh", "file"],
      ["root/link.md", "symlink"],
      [longPath, "file"],
      ["root/far", "symlink"],
      ["root/big.bin", "file"],
    ]);
    expect(entries.find((entry) => entry.path === "root/run.sh")?.mode).toBe(0o775);
    expect(entries.find((entry) => entry.path === "root/link.md")?.linkTarget).toBe("SKILL.md");
    expect(entries.find((entry) => entry.path === "root/far")?.linkTarget).toBe(`${"../".repeat(40)}etc/passwd`);
    expect(contents.get(longPath)).toBe("# deep\n");
    expect(contents.get("root/big.bin")).toBe("A".repeat(5000));
  });

  it("F-145: lets a skipped file stream past without holding it, and stops when asked", async () => {
    const skipped = await read(archive, (entry) => (entry.path === "root/big.bin" ? "skip" : "read"), 512);
    expect(skipped.contents.has("root/big.bin")).toBe(false);
    expect(skipped.contents.get("root/SKILL.md")).toBe("# skill\n");
    const stopped = await read(archive, (entry) => (entry.path === "root/run.sh" ? "stop" : "read"));
    expect(stopped.outcome).toEqual({ ok: true, value: "stopped" });
    expect(stopped.entries.map((entry) => entry.path)).toEqual(["root/", "root/SKILL.md", "root/run.sh"]);
  });

  it("F-145: refuses an archive cut short, or with a header whose checksum doesn't match, in words with no content", async () => {
    const cut = await read(archive.subarray(0, 2048));
    expect(cut.outcome).toMatchObject({ ok: false });
    const tampered = Buffer.from(archive);
    // The first file's header: after the global header (one block and its body's block) and the folder's.
    tampered[3 * 512 + 10] = 0x5a;
    const bad = await read(tampered);
    expect(bad.outcome).toEqual({ ok: false, error: "an archive header's checksum doesn't match" });
    expect(JSON.stringify(bad.outcome)).not.toContain("SKILL");
  });

  it("F-145: a source's own failure is thrown, not read as the archive's", async () => {
    // eslint-disable-next-line func-style -- a generator can't be an arrow function
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield archive.subarray(0, 1024);
      await Promise.resolve();
      throw new TypeError("the connection dropped");
    }
    await expect(readTar(failing(), { entry: () => "read", bytes: () => undefined })).rejects.toThrow("the connection dropped");
  });
});
