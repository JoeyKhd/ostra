import { describe, expect, it } from "vitest";

import { cleanUp, clockSkewRefusal } from "./github.ts";
import type { DemoGitHub } from "./github.ts";

type FakePull = { readonly number: number; readonly head: { readonly ref: string } };

// Just the Octokit calls `cleanUp` makes, recording what it closes and deletes.
const fakeGitHub = (pulls: readonly FakePull[], refs: readonly string[]) => {
  const closed: number[] = [];
  const deleted: string[] = [];
  const octokit = {
    rest: {
      pulls: {
        list: () => Promise.resolve({ data: pulls }),
        update: (args: { readonly pull_number: number }) => {
          closed.push(args.pull_number);
          return Promise.resolve({});
        },
      },
      git: {
        listMatchingRefs: (args: { readonly ref: string }) =>
          Promise.resolve({ data: refs.filter((ref) => ref.startsWith(`refs/${args.ref}`)).map((ref) => ({ ref })) }),
        deleteRef: (args: { readonly ref: string }) => {
          deleted.push(args.ref);
          return Promise.resolve({});
        },
      },
    },
  };
  // @ts-expect-error a fake that implements only the calls cleanUp makes
  // eslint-disable-next-line @typescript-eslint/no-unsafe-class-instance-assignment -- the same fake, for the same reason
  const github: DemoGitHub = { octokit, owner: "org", repo: "repo", botLogin: "ostra-test[bot]" };
  return { github, closed, deleted };
};

const taskId = "0190aaaa-bbbb-7ccc-8ddd-0123456789ab";
const keptBranch = "ostra/456789ab-add-docs";

describe("cleanUp", () => {
  it("leaves a kept PR, its branch and its hidden ref, and removes the rest", async () => {
    const { github, closed, deleted } = fakeGitHub(
      [
        { number: 19, head: { ref: keptBranch } },
        { number: 20, head: { ref: "ostra/11111111-other" } },
        { number: 21, head: { ref: "feature/not-ours" } },
      ],
      [`refs/heads/${keptBranch}`, "refs/heads/ostra/11111111-other", "refs/heads/ostra/22222222-never-opened", `refs/ostra/wip/${taskId}`, "refs/ostra/wip/0190aaaa-bbbb-7ccc-8ddd-111111111111"],
    );
    const result = await cleanUp(github, new Set([19]));
    expect(closed).toEqual([20]);
    expect(deleted).toEqual(["heads/ostra/11111111-other", "heads/ostra/22222222-never-opened", "ostra/wip/0190aaaa-bbbb-7ccc-8ddd-111111111111"]);
    expect(result).toEqual({ closed: 1, deleted: 3 });
  });

  it("closes every demo PR when nothing is kept", async () => {
    const { github, closed } = fakeGitHub([{ number: 19, head: { ref: keptBranch } }], [`refs/heads/${keptBranch}`]);
    expect(await cleanUp(github)).toEqual({ closed: 1, deleted: 1 });
    expect(closed).toEqual([19]);
  });
});

describe("clockSkewRefusal", () => {
  const now = Date.parse("2026-11-19T10:04:06Z");
  const refusal = (date: string) => ({ status: 401, message: "Bad credentials", response: { status: 401, headers: { date }, data: {} } });

  it("names a clock an hour behind GitHub's, the refusal milestone 1's final runs met", () => {
    const message = clockSkewRefusal(refusal("Thu, 19 Nov 2026 11:03:58 GMT"), now);
    expect(message).toContain("this machine's clock is 60 minutes behind GitHub's");
    expect(clockSkewRefusal(refusal("Thu, 19 Nov 2026 09:00:00 GMT"), now)).toContain("64 minutes ahead of GitHub's");
  });

  it("leaves a refusal alone when the clocks agree, or when it isn't a 401 with a date", () => {
    expect(clockSkewRefusal(refusal("Thu, 19 Nov 2026 10:06:00 GMT"), now)).toBeNull();
    expect(clockSkewRefusal({ ...refusal("Thu, 19 Nov 2026 11:03:58 GMT"), status: 404 }, now)).toBeNull();
    expect(clockSkewRefusal({ status: 401, response: { headers: {} } }, now)).toBeNull();
    expect(clockSkewRefusal(new Error("Bad credentials"), now)).toBeNull();
    expect(clockSkewRefusal(refusal("not a date"), now)).toBeNull();
  });
});
