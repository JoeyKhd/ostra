-- Q163, F-068 (milestone 2, ticket 19): the key proxy counts four kinds of token, each priced on its
-- own. The model had prices for fresh input and output only; these are the other two, in US dollars
-- per million tokens, from the catalog or an admin. Null: not known, and the spend count prices that
-- kind at the input price, which never undercounts a cache read. Additive: two nullable columns.
ALTER TABLE "model" ADD COLUMN "cacheReadPricePerMTok" DECIMAL(12,6);
ALTER TABLE "model" ADD COLUMN "cacheWritePricePerMTok" DECIMAL(12,6);
