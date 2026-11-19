-- Protocol minor 4 (milestone 5, ticket 01): the `resume` command. Additive: an enum value
-- only. The rest of milestone 5's schema is ticket 04's migration.

-- AlterEnum
ALTER TYPE "CommandKind" ADD VALUE 'resume';
