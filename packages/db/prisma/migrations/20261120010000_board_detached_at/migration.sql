-- F-007 (milestone 2, ticket 28): a board a project admin detaches stops polling and starts no new
-- task, but its tickets stay cached and its tasks keep their links, so the row is kept and marked.
-- Additive: one nullable column.
ALTER TABLE "board" ADD COLUMN "detachedAt" TIMESTAMP(3);
