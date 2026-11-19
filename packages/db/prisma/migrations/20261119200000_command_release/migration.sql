-- Protocol minor 1 (milestone 2, ticket 02): the `release` command. Additive: an enum value
-- only. The rest of milestone 2's schema is ticket 05's migration.

-- AlterEnum
ALTER TYPE "CommandKind" ADD VALUE 'release';
