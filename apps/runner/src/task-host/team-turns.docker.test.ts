import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { startLocalDockerBox } from "../testing/docker-box.ts";
import { teamTurnsCases } from "../testing/team-turns-cases.ts";

// Ticket 23 (F-101, F-113, F-035) on the `docker` executor as a box's sidecar drives it:
// `DockerExecutor` through the real bridge to a local init, where the first turn's `automatic`
// comes from the spec alone, as the sidecar's own dispatch carries none. Automatic turns, the
// onboarding commit's filter and a CI round's log files, behind the real git proxy with the
// scripted fake agent. The same cases on `host` are `team-turns.host.test.ts`.

const cases = teamTurnsCases({ name: "docker", makeExecutor: startLocalDockerBox });

beforeAll(cases.setup, 60_000);
afterAll(cases.teardown, 60_000);
afterEach(cases.cleanup, 120_000);

describe("automatic turns, commit filters and CI logs on docker (ticket 23)", () => {
  it("F-101/c5: on docker, a question in an automatic turn gets the neutral reply and the turn carries on", cases.automaticQuestion, 180_000);
  it("F-101/c5: on docker, the same question in a member's turn waits for a person, and an automatic round's on the same session gets the neutral reply", cases.memberQuestion, 180_000);
  it("F-101/c5: on docker, an approval in an automatic turn still follows the profile's rules and waits for a person", cases.automaticApproval, 180_000);
  it("F-113/c3,c4: on docker, an onboarding turn that changed a lockfile and added AGENTS.md pushes only AGENTS.md, to the branch and the hidden ref", cases.onlyAgentsMd, 180_000);
  it("F-113/c4: on docker, the onboarding agent's own push of another path is refused in words it reads, and the turn still delivers only AGENTS.md", cases.agentPushRefused, 180_000);
  it("F-113/c3: on docker, an agent commit touching other paths is rebuilt as one commit on the base, and commit.filtered lists what was left", cases.agentCommitRebuilt, 180_000);
  it("F-113/c3: on docker, a repo with nothing allowed changed isn't pushed, and commit.filtered lists at most 50 paths with the count", cases.nothingAllowedNotPushed, 180_000);
  it("F-035/c1: on docker, a CI round's log tails are written under .ostra/ci, and never into a commit or the hidden ref", cases.ciLogs, 180_000);
});
