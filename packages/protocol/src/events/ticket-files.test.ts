import { describe, expect, it } from "vitest";

import { ticketFileNameFor, ticketFileNameSchema, TICKET_FILE_EXTENSIONS } from "./agent-events.ts";

// Ticket 26: a ticket file's name comes from its blob and its type, never from the ticket's text,
// and it's always one plain name inside the ticket folder.

describe("a ticket file's name", () => {
  it("is the blob ID and the type's extension", () => {
    expect(ticketFileNameFor("0196f1a0-0000-7000-8000-000000000011", "image/png")).toBe("0196f1a0-0000-7000-8000-000000000011.png");
    expect(ticketFileNameFor("0196f1a0-0000-7000-8000-000000000012", "IMAGE/JPEG")).toBe("0196f1a0-0000-7000-8000-000000000012.jpg");
    expect(ticketFileNameFor("blob-1", "application/pdf")).toBe("blob-1.pdf");
  });

  it("is null for a type that isn't an image or a PDF", () => {
    expect(ticketFileNameFor("blob-1", "text/html")).toBeNull();
    expect(ticketFileNameFor("blob-1", "application/x-sh")).toBeNull();
  });

  it("can never leave the folder, whatever the blob ID holds", () => {
    for (const blobId of ["../../etc/passwd", "a/b\\c", "..", "-", "C:\\x", "x\u0000y"]) {
      const name = ticketFileNameFor(blobId, "image/png");
      expect(name).not.toBeNull();
      expect(ticketFileNameSchema.safeParse(name).success).toBe(true);
      expect(name).not.toMatch(/[\\/]/);
      expect(name?.startsWith(".")).toBe(false);
    }
  });

  it("names an extension for every allowed type", () => {
    for (const [type, extension] of Object.entries(TICKET_FILE_EXTENSIONS)) {
      expect(type).toMatch(/^(image\/|application\/pdf$)/);
      expect(extension).toMatch(/^[a-z]+$/);
    }
  });
});
