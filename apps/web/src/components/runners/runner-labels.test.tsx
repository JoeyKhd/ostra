import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { poolChips, poolLines } from "./fleet-words";
import { RunnerKind } from "./runners-view";

// F-014 and F-015 (ADR 0029): what the panel calls a runner that runs the agent as a process on its
// machine. A personal runner is on `host`, so it reads "personal, not isolated"; a pool an admin
// put on `host` reads "not isolated", and its page says the agent runs as its own OS user. The
// facts come from `runners.mine`, `runners.list` and `pools.list` (`isolated`, `lines`), whose own
// tests are `packages/api/src/routers/runners.test.ts` and `fleet.test.ts`.

/** The text a render shows, its tags and attributes left out. */
const textOf = (html: string): string => html.replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " ").trim();

describe("a runner's isolation in the panel's words", () => {
  it("F-014/c2: a personal runner on host is labelled personal and not isolated, and a pool runner in a box is not", () => {
    expect(textOf(renderToStaticMarkup(<RunnerKind runner={{ kind: "personal", executor: "host", isolated: false }} />))).toBe("personal host not isolated");
    expect(textOf(renderToStaticMarkup(<RunnerKind runner={{ kind: "pool", executor: "docker", isolated: true }} />))).toBe("pool docker");
  });

  it("F-015/c5, F-116/c3: a host pool, whose executor enforces no egress baseline, is labelled not isolated on the Runners page and its own, and a docker pool is not", () => {
    expect(poolChips(["not-isolated"])).toEqual(["not isolated"]);
    expect(poolLines(["not-isolated"])).toEqual([{ icon: "shield", text: "Not isolated: the agent runs as its own OS user on the runner's machine, not in a container." }]);
    // Its runners' rows say it too.
    expect(textOf(renderToStaticMarkup(<RunnerKind runner={{ kind: "pool", executor: "host", isolated: false }} />))).toBe("pool host not isolated");
    expect(poolChips([])).toEqual([]);
    expect(poolLines([])).toEqual([]);
  });
});
