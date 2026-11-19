import { repoIdSchema } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { describe, expect, it } from "vitest";
import { reposSection } from "../testing/several-repos-cases.ts";
import { checkRepoFolders, listedRepoFolders } from "./repo-folders.ts";

// Ticket 21 (F-098): the runner checks the folders it checks out against the ones core told the agent about.

const [first] = taskSpecFixture.repos;
if (first === undefined) {
  throw new Error("the fixture has a repo");
}
const second = { ...first, repoId: repoIdSchema.parse("repo-test2"), checkoutDir: "test2" };

describe("the repos' folders", () => {
  it("F-098: takes the folders core listed, in the spec's order, and a spec whose instructions list none", () => {
    const repos = [first, second];
    expect(listedRepoFolders(`Be careful.\n\n${reposSection(repos, "ostra/work")}`)).toEqual(["test1", "test2"]);
    expect(checkRepoFolders({ repos, agent: { instructions: reposSection(repos, "ostra/work") } })).toEqual({ ok: true });
    expect(checkRepoFolders({ repos, agent: { instructions: "The profile's own text." } })).toEqual({ ok: true });
    expect(checkRepoFolders({ repos: [first], agent: { instructions: null } })).toEqual({ ok: true });
  });

  it("F-098: refuses two repos in one folder, case aside, and a list in another order or with other folders", () => {
    expect(checkRepoFolders({ repos: [first, { ...second, checkoutDir: "TEST1" }], agent: { instructions: null } })).toEqual({ ok: false, error: "two of the task's repos share the folder TEST1" });
    expect(checkRepoFolders({ repos: [first, second], agent: { instructions: reposSection([second, first], "ostra/work") } })).toMatchObject({ ok: false });
    expect(checkRepoFolders({ repos: [first, second], agent: { instructions: reposSection([first], "ostra/work") } })).toMatchObject({ ok: false });
  });
});
