-- The install's email keeps its secrets in the secret store, which keys values by organization:
-- this names the organization whose namespace holds them (F-115, ticket 21). Additive.
ALTER TABLE "email_settings" ADD COLUMN "secretsOrganizationId" TEXT;
