-- Q136, milestone 2's ticket 45 (2026-11-19): a value sealed with the secrets key, per key version,
-- that core and the panel open at every start. Additive: an install that upgrades stores its check
-- at its next start (AGENTS.md: add first).

-- CreateTable
CREATE TABLE "secrets_key_check" (
    "keyVersion" INTEGER NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "secrets_key_check_pkey" PRIMARY KEY ("keyVersion")
);
