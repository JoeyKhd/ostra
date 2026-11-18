# 14: The built-in secret store adapter

Status: resolved
Builder: adapters
Blocked by: 04
Features: F-088, F-006, F-050 (where their secrets live); ADR 0030
Packages: `packages/adapters/adapter-secret-store-builtin` (new, Apache-2.0)
Spec: `../spec.md`, section 11 (item 1)

## What to build

`BuiltinSecretStore extends SecretStoreAdapter`.

- AES-256-GCM with a fresh random nonce per value, from `node:crypto`. The key comes from the caller (the server's `OSTRA_SECRETS_KEY`, or the key it generated into its data folder, ticket 08). The organization ID and the secret's name are the associated data, so a row moved to another organization doesn't decrypt.
- Rows go through the injected `SecretRowStore` (ticket 04). The server implements it with Postgres (`Secret` model, ticket 06) in ticket 26; tests use the in-memory one.
- `put` returns a `SecretRef`; `get` returns the value or a typed failure; `delete`. A key version in each row, so rotation can come later (`rotation: false` in milestone 1).
- The secret store contract suite.

## Done when

- [x] The suite passes; a row moved to another organization, or with one changed byte, fails to decrypt with a typed failure.
- [x] A test proves no value reaches a log line on any path.
- [x] Package checks and `pnpm check:licenses` pass.
- [x] Committed as `✨ add the built-in secret store`.

## Comments

- 2026-11-18, adapters: done in c92c576 (`✨ add the built-in secret store`), package `packages/adapters/adapter-secret-store-builtin`. AES-256-GCM with a fresh nonce per value; the associated data is the organization ID, the purpose and the row ID, so a moved row, a changed purpose and a changed byte all fail with `invalid-response` (a typed failure). `parseSecretsKey` takes 64 hex characters or 32 bytes of base64, and `generateSecretsKey` makes the one the server writes to its data folder. The key version is in each row; `rotation` is false. A test walks every path and finds no value in a log line.
