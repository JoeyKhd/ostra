import type { webcrypto } from "node:crypto";

// @linear/sdk's declaration files name two DOM types, `JsonWebKey` and `CryptoKeyPair`, for its DPoP signer.
// ostra's root tsconfig has `skipLibCheck: true`, where the SDK typechecks with no shim and no errors (the
// `measure/root-style` project checks that). This spike also checks with `skipLibCheck: false`, which makes tsc
// read the SDK's own declarations, and with no DOM in `lib` those two names are unknown. These aliases answer
// with Node's own equivalents. They are needed only if ostra turns `skipLibCheck` off (see README, Bullet 5).
declare global {
  type JsonWebKey = webcrypto.JsonWebKey;
  type CryptoKeyPair = webcrypto.CryptoKeyPair;
}
