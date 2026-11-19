-- F-044 (milestone 2, ticket 14): the drift check's two facts for the panel. A webhook connection
-- whose webhooks went silent while polling still found changes is flagged, never switched to
-- polling on its own; and a board's last poll keeps how many tickets it changed. Additive: two
-- nullable columns.
ALTER TABLE "connection" ADD COLUMN "webhooksSilentSince" TIMESTAMP(3);
ALTER TABLE "board" ADD COLUMN "lastPollChanged" INTEGER;
