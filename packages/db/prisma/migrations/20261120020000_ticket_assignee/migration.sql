-- F-010 (milestone 2, ticket 29): the Inbox filters tickets by assignee and shows who it is. Additive:
-- two nullable columns on the ticket cache.
ALTER TABLE "ticket" ADD COLUMN "assigneeId" TEXT, ADD COLUMN "assigneeName" TEXT;
