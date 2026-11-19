-- Milestone 3 (F-026, ADR 0049, ticket 17): an open approval names the rule that asked for it, in
-- `ruleId` with its `ruleSource`. Milestone 1's check let `ruleId` hold only the rule that answered,
-- so it refused an open approval with one. The check is relaxed, never tightened: every row it
-- accepted before it still accepts, and an open row's `ruleId` needs its `ruleSource`.
ALTER TABLE "approval" DROP CONSTRAINT "approval_state_fields";
ALTER TABLE "approval" ADD CONSTRAINT "approval_state_fields" CHECK (
  ("state" = 'open' AND "decision" IS NULL AND "closedReason" IS NULL AND ("ruleId" IS NULL OR "ruleSource" IS NOT NULL))
  OR ("state" = 'answered' AND "decision" IS NOT NULL AND "optionId" IS NOT NULL AND "answeredByMemberId" IS NOT NULL)
  OR ("state" = 'answered_by_rule' AND "decision" IS NOT NULL AND "ruleId" IS NOT NULL)
  OR ("state" = 'closed' AND "closedReason" IS NOT NULL)
);
