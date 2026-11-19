// A tar archive in memory (ustar, 512-byte blocks), for the fake registries' layers and npm
// tarballs (ticket 06). Regular files only. Test and dev only.

export type TarEntry = { readonly name: string; readonly content: Buffer; readonly mode?: number };

export const tarOf = (entries: readonly TarEntry[]): Buffer => {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    if (Buffer.byteLength(entry.name) > 100) throw new Error(`a tar entry's name is at most 100 bytes: ${entry.name}`);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, "utf8");
    header.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100, "latin1");
    header.write("0000000\0", 108, "latin1");
    header.write("0000000\0", 116, "latin1");
    header.write(`${entry.content.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
    header.write(`${Math.floor(Date.UTC(2026, 0, 1) / 1000).toString(8).padStart(11, "0")}\0`, 136, "latin1");
    header.write("        ", 148, "latin1");
    header.write("0", 156, "latin1");
    header.write("ustar\u000000", 257, "latin1");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    blocks.push(header, entry.content, Buffer.alloc((512 - (entry.content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
};
