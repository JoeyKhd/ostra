/** What a secret store adapter can do (ADR 0025, F-133). */
export type SecretStoreCapabilities = {
  /** It can re-encrypt or rotate a value in place, keeping its reference. */
  readonly rotation: boolean;
};
