import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { runnerIdSchema } from "../ids.ts";
import {
  infoResponseSchema,
  parseHttpUpBody,
  registerRequestSchema,
  runnerHttpErrorSchema,
  runnerPaths,
  taskCredentialsRequestSchema,
  taskSpecQuerySchema,
  tokenAssertionCanonicalString,
  tokenAssertionSchema,
} from "./http.ts";
import { PROTOCOL_MINOR } from "./version.ts";

// A fixed Ed25519 key pair: the 32-byte seed 00 01 02 … 1f, wrapped as PKCS#8.
const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";
const seed = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from(PKCS8_ED25519_PREFIX, "hex"), seed]),
  format: "der",
  type: "pkcs8",
});
const publicKey = createPublicKey(privateKey);

const vector = {
  runnerId: runnerIdSchema.parse("runner-1"),
  issuedAt: 1_900_000_000_000,
  nonce: "AAECAwQFBgcICQoLDA0ODw",
  publicKey: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
  canonical: "ostra-runner-token-v1\nrunner-1\n1900000000000\nAAECAwQFBgcICQoLDA0ODw",
  signature: "FTWrsMJzIk5-fUT7kBR5MjCjychk2FwkRdY8i-oJWxqUFYdHqZL2NPUuG-m_ejZQS_elIyyRTea3xEltm_Q-Dw",
} as const;

describe("the signed token assertion", () => {
  it("builds the documented canonical string", () => {
    expect(tokenAssertionCanonicalString(vector)).toBe(vector.canonical);
  });

  it("matches the test vector: public key, signature, and verification", () => {
    const jwk: unknown = publicKey.export({ format: "jwk" });
    expect(jwk).toMatchObject({ kty: "OKP", crv: "Ed25519", x: vector.publicKey });

    const signature = sign(null, Buffer.from(tokenAssertionCanonicalString(vector), "utf8"), privateKey);
    expect(signature.toString("base64url")).toBe(vector.signature);
    expect(verify(null, Buffer.from(vector.canonical, "utf8"), publicKey, signature)).toBe(true);
    expect(verify(null, Buffer.from(`${vector.canonical}\n`, "utf8"), publicKey, signature)).toBe(false);
  });

  it("parses the vector as an assertion and refuses an unknown field", () => {
    const assertion = {
      runnerId: vector.runnerId,
      issuedAt: vector.issuedAt,
      nonce: vector.nonce,
      signature: vector.signature,
    };
    expect(tokenAssertionSchema.parse(assertion)).toEqual(assertion);
    expect(tokenAssertionSchema.safeParse({ ...assertion, extra: 1 }).success).toBe(false);
    expect(tokenAssertionSchema.safeParse({ ...assertion, signature: "short" }).success).toBe(false);
  });

  it("documents the canonical string in the schema's description", () => {
    expect(tokenAssertionSchema.description).toContain("ostra-runner-token-v1");
  });
});

describe("the runner endpoints", () => {
  it("puts every path under /runner/v1", () => {
    expect(runnerPaths.info).toBe("/runner/v1/info");
    expect(runnerPaths.taskSpec("t/1")).toBe("/runner/v1/tasks/t%2F1/spec");
    expect(runnerPaths.taskCredentials("t1")).toBe("/runner/v1/tasks/t1/credentials");
  });

  it("parses info, register and the credentials request, strictly", () => {
    const info = {
      protocolMajor: 1,
      serverMinor: 0,
      supported: { min: 0, max: 1 },
      serverVersion: "0.1.0",
      panelUrl: "http://localhost:3000",
      deviceClientId: "ostra-runner",
    };
    expect(infoResponseSchema.parse(info)).toEqual(info);
    expect(infoResponseSchema.safeParse({ ...info, more: true }).success).toBe(false);

    const register = {
      publicKey: vector.publicKey,
      name: "laptop",
      executor: "host",
      capacity: 1,
      labels: ["windows"],
      os: { platform: "win32", arch: "x64", release: "10.0.26200" },
      version: "0.1.0",
    };
    expect(registerRequestSchema.parse(register)).toEqual(register);
    expect(registerRequestSchema.safeParse({ ...register, publicKey: "nope" }).success).toBe(false);

    expect(taskCredentialsRequestSchema.safeParse({ taskId: "t1", leaseEpoch: 0 }).success).toBe(false);
    expect(taskSpecQuerySchema.parse({ leaseEpoch: "3" })).toEqual({ leaseEpoch: 3 });
    expect(runnerHttpErrorSchema.parse({ error: { code: "stale-lease", message: "stale", currentEpoch: 4 } })).toBeTruthy();
  });

  it("parses an HTTP carrier body frame by frame, naming the bad one", () => {
    const status = {
      type: "status",
      executor: "host",
      capacity: 1,
      freeSlots: 1,
      labels: [],
      version: "0.1.0",
      running: [],
      spoolBytes: 0,
    };
    expect(parseHttpUpBody({ frames: [status] }, PROTOCOL_MINOR)).toMatchObject({ ok: true });
    const bad = parseHttpUpBody({ frames: [status, { type: "status" }] }, PROTOCOL_MINOR);
    expect(bad.ok).toBe(false);
    expect(bad.ok ? "" : bad.detail).toMatch(/^frames\.1: /);
    expect(parseHttpUpBody([status], PROTOCOL_MINOR).ok).toBe(false);
  });
});
