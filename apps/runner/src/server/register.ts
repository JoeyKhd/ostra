import os from "node:os";
import { registerRequestSchema, registerResponseSchema, runnerPaths } from "@ostra/protocol";
import type { ExecutorKind, RegisterRequest, RegisterResponse, RunnerLabel, RunnerOs } from "@ostra/protocol";
import { RUNNER_VERSION } from "../version.ts";
import { callJson, joinUrl } from "./http.ts";
import type { CallResult } from "./http.ts";

// `POST /runner/v1/register`: a runner's first contact (ADR 0029, Q115). A personal runner proves
// who it is with the member's device session as the bearer; the server revokes that session once
// the runner exists. A pool runner sends its pool's join token instead.

export type RegisterProof =
  | { readonly kind: "device-session"; readonly sessionToken: string }
  | { readonly kind: "join-token"; readonly joinToken: string };

export type RegisterInput = {
  readonly serverUrl: string;
  readonly publicKey: string;
  readonly name: string;
  readonly executor: ExecutorKind;
  readonly capacity: number;
  readonly labels: readonly RunnerLabel[];
  readonly proof: RegisterProof;
};

/** ostra runs on these three (ADR 0029); anything else reports as Linux-like. */
const platformOf = (platform: NodeJS.Platform): RunnerOs["platform"] =>
  platform === "win32" || platform === "darwin" ? platform : "linux";

export const runnerOs = (): RunnerOs => ({ platform: platformOf(process.platform), arch: os.arch(), release: os.release() });

export const register = async (input: RegisterInput): Promise<CallResult<RegisterResponse>> => {
  const body: RegisterRequest = registerRequestSchema.parse({
    publicKey: input.publicKey,
    name: input.name,
    executor: input.executor,
    capacity: input.capacity,
    labels: [...input.labels],
    os: runnerOs(),
    version: RUNNER_VERSION,
    ...(input.proof.kind === "join-token" ? { joinToken: input.proof.joinToken } : {}),
  });
  return callJson({
    url: joinUrl(input.serverUrl, runnerPaths.register),
    method: "POST",
    schema: registerResponseSchema,
    body,
    ...(input.proof.kind === "device-session" ? { bearer: input.proof.sessionToken } : {}),
  });
};
