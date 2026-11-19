import { describe, expect, it } from "vitest";

import { fixtureIds as ids } from "../testing/fixtures.ts";
import {
  cliDeviceRequestSchema,
  cliDeviceResponseSchema,
  cliDeviceTokenErrorSchema,
  cliDeviceTokenResponseSchema,
  cliHttpErrorSchema,
  cliPaths,
  cliSessionDeleteResponseSchema,
  cliSessionMessages,
  cliTaskBranchesResponseSchema,
} from "./http.ts";

// The CLI's HTTP (F-103, ADR 0051): `ostra login`, `ostra checkout` and `ostra logout`.

const token = `ostra_cli_${"a".repeat(43)}`;

const branches = {
  taskId: ids.task,
  key: ids.ticketKey,
  repos: [
    {
      fullName: "ostra-test/test1",
      cloneUrl: "https://github.com/ostra-test/test1.git",
      branch: "ostra/ost-12-add-date",
      baseBranch: "main",
      headSha: "0123456789abcdef0123456789abcdef01234567",
    },
    {
      fullName: "ostra-test/test2",
      cloneUrl: "https://github.com/ostra-test/test2.git",
      branch: "ostra/ost-12-add-date",
      baseBranch: "main",
      headSha: null,
    },
  ],
};

describe("the CLI's paths", () => {
  it("F-103: live under /api/cli/v1, with the task's ref encoded", () => {
    expect(cliPaths.device).toBe("/api/cli/v1/device");
    expect(cliPaths.deviceToken).toBe("/api/cli/v1/device/token");
    expect(cliPaths.session).toBe("/api/cli/v1/session");
    expect(cliPaths.taskBranches("OST-12")).toBe("/api/cli/v1/tasks/OST-12/branches");
    expect(cliPaths.taskBranches("https://ostra.example/t/1")).toBe(
      "/api/cli/v1/tasks/https%3A%2F%2Fostra.example%2Ft%2F1/branches",
    );
  });
});

describe("the device-code grant", () => {
  it("F-103: round-trips the request, the code and the session", () => {
    const request = { name: "joey-laptop", version: "0.3.0" };
    expect(cliDeviceRequestSchema.parse(request)).toEqual(request);
    const code = {
      deviceCode: "d".repeat(32),
      userCode: "WDJB-MJHT",
      verificationUrl: "http://localhost:3000/device",
      verificationUrlComplete: "http://localhost:3000/device?user_code=WDJB-MJHT",
      expiresAt: 1_900_000_000_000,
      intervalSeconds: 5,
    };
    expect(cliDeviceResponseSchema.parse(code)).toEqual(code);
    const session = { sessionId: "cli-1", token, expiresAt: 1_900_000_000_000, username: "admin" };
    expect(cliDeviceTokenResponseSchema.parse(session)).toEqual(session);
    for (const code of ["authorization-pending", "slow-down", "access-denied", "expired-token"] as const) {
      const body = { error: { code, message: "not yet" } };
      expect(cliDeviceTokenErrorSchema.parse(body)).toEqual(body);
    }
  });

  it("F-103: refuses a token that isn't a CLI session's, and an unknown field", () => {
    const session = { sessionId: "cli-1", token, expiresAt: 1, username: "admin" };
    expect(cliDeviceTokenResponseSchema.safeParse({ ...session, token: "ghs_abc" }).success).toBe(false);
    expect(cliDeviceTokenResponseSchema.safeParse({ ...session, refreshToken: "x" }).success).toBe(false);
    expect(cliDeviceRequestSchema.safeParse({ name: "  ", version: "1" }).success).toBe(false);
  });
});

describe("a task's branches", () => {
  it("F-103: hands out branch names and clone URLs, and no token", () => {
    expect(cliTaskBranchesResponseSchema.parse(branches)).toEqual(branches);
    expect(cliTaskBranchesResponseSchema.parse({ ...branches, key: null }).key).toBeNull();
    const withToken = { ...branches, repos: [{ ...branches.repos[0], token: "ghs_x" }] };
    expect(cliTaskBranchesResponseSchema.safeParse(withToken).success).toBe(false);
    const withCredentials = { ...branches, repos: [{ ...branches.repos[0], cloneUrl: "https://x:ghs_y@github.com/a/b.git" }] };
    expect(cliTaskBranchesResponseSchema.parse(withCredentials).repos[0]?.cloneUrl).toContain("github.com");
    expect(cliTaskBranchesResponseSchema.safeParse({ ...branches, repos: [] }).success).toBe(false);
    expect(cliSessionDeleteResponseSchema.parse({ revoked: true })).toEqual({ revoked: true });
  });
});

describe("a refused session", () => {
  it("F-103: answers 401 with a message the CLI prints", () => {
    for (const [code, message] of Object.entries(cliSessionMessages)) {
      const body = { error: { code, message } };
      expect(cliHttpErrorSchema.parse(body)).toEqual(body);
      expect(message).toContain("ostra login");
    }
    expect(cliHttpErrorSchema.safeParse({ error: { code: "teapot", message: "x" } }).success).toBe(false);
  });
});
