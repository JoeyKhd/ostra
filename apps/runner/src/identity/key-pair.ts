import { createPrivateKey, createPublicKey, generateKeyPair, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { promisify } from "node:util";
import { ed25519PublicKeySchema, tokenAssertionCanonicalString, tokenAssertionSchema } from "@ostra/protocol";
import type { RunnerId, TokenAssertion } from "@ostra/protocol";
import { z } from "zod";

// The runner's identity (ADR 0034): an Ed25519 key pair made on this machine. The private key
// never leaves it; the server keeps the public key and checks each signed assertion with it.

const generate = promisify(generateKeyPair);
const signAsync = promisify(sign);

export type RunnerKeyPair = {
  readonly privateKey: KeyObject;
  /** The raw 32-byte public key in base64url, as `POST /runner/v1/register` takes it. */
  readonly publicKey: string;
};

const jwkSchema = z.looseObject({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: ed25519PublicKeySchema });

const publicKeyOf = (privateKey: KeyObject): string => {
  const jwk: unknown = createPublicKey(privateKey).export({ format: "jwk" });
  return jwkSchema.parse(jwk).x;
};

export const generateRunnerKeyPair = async (): Promise<RunnerKeyPair> => {
  const { privateKey } = await generate("ed25519");
  return { privateKey, publicKey: publicKeyOf(privateKey) };
};

/** The private key as PKCS#8 PEM, for the owner-only key file. */
export const privateKeyToPem = (keyPair: RunnerKeyPair): string =>
  keyPair.privateKey.export({ format: "pem", type: "pkcs8" });

export const keyPairFromPem = (pem: string): RunnerKeyPair => {
  const privateKey = createPrivateKey({ key: pem, format: "pem" });
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("the runner's key file doesn't hold an Ed25519 key");
  }
  return { privateKey, publicKey: publicKeyOf(privateKey) };
};

/** A fresh signed assertion for `POST /runner/v1/token`: single-use, by its random nonce. */
export const signTokenAssertion = async (
  keyPair: RunnerKeyPair,
  runnerId: RunnerId,
  issuedAt: number,
): Promise<TokenAssertion> => {
  const nonce = randomBytes(16).toString("base64url");
  const canonical = tokenAssertionCanonicalString({ runnerId, issuedAt, nonce });
  const signature = await signAsync(null, Buffer.from(canonical, "utf8"), keyPair.privateKey);
  return tokenAssertionSchema.parse({ runnerId, issuedAt, nonce, signature: signature.toString("base64url") });
};
