-- `memory_search` ranks a question by its meaningful words (F-110, ADR 0044's 2026-11-21 note,
-- borrowed from claude-mem: `context/research/claude-mem.md`). A second generated `tsvector` on
-- `memory_note`, under the `english` configuration: stop words dropped, words stemmed, the title
-- weighted `A` and the body `B`. The `simple` `vector` stays as it is, for the code-ish terms the
-- `english` configuration would stem, for the Memory page's search and for the related notes.
-- Additive: Postgres fills the column for every existing note when it's added, and no write ever
-- sets it.

-- AlterTable
ALTER TABLE "memory_note" ADD COLUMN "searchVector" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', "title"), 'A') || setweight(to_tsvector('english', "body"), 'B')
) STORED;

-- CreateIndex
CREATE INDEX "memory_note_search_vector_idx" ON "memory_note" USING GIN ("searchVector");
