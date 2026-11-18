// The registry of cases, in the order `pnpm spike` runs them.

import type { CaseContext } from "../harness/fixture.ts";
import type { Criterion } from "../harness/report.ts";
import { httpFallback } from "./http-fallback.ts";
import { steerProbe } from "./steer-probe.ts";
import { t10ModelMode } from "./t10-model-mode.ts";
import { t11Resume } from "./t11-resume.ts";
import { t13Crash } from "./t13-crash.ts";
import { t14Cleanup } from "./t14-cleanup.ts";
import { t16Resources } from "./t16-resources.ts";
import { t1Offline } from "./t1-offline.ts";
import { t3AnyEndpoint } from "./t3-any-endpoint.ts";
import { t4LongTurn } from "./t4-long-turn.ts";
import { t5Events } from "./t5-events.ts";
import { t6Concurrency } from "./t6-concurrency.ts";
import { t7Permissions } from "./t7-permissions.ts";
import { t8Questions } from "./t8-questions.ts";
import { t9Interrupt } from "./t9-interrupt.ts";
import { turnsAndKeys } from "./turns-and-keys.ts";

export type CaseEntry = {
  /** The criterion IDs it produces, for --only. */
  readonly ids: readonly string[];
  readonly title: string;
  readonly run: (ctx: CaseContext) => Promise<Criterion[]>;
};

export const cases: readonly CaseEntry[] = [
  // T1 first: its packet capture must not see the harness's own earlier connections to the endpoint.
  { ids: ["T1"], title: "Offline, pinned install", run: t1Offline },
  { ids: ["B3", "B4"], title: "Turns on both formats and the endpoint; fake key only; token count", run: turnsAndKeys },
  { ids: ["T3"], title: "Any base URL and model", run: t3AnyEndpoint },
  { ids: ["T4"], title: "Long turn", run: t4LongTurn },
  { ids: ["T5"], title: "Event completeness", run: t5Events },
  { ids: ["T6"], title: "Concurrency and integrity", run: t6Concurrency },
  { ids: ["T7"], title: "Permissions", run: t7Permissions },
  { ids: ["T8"], title: "Questions", run: t8Questions },
  { ids: ["T9"], title: "Steering and interrupt", run: t9Interrupt },
  { ids: ["T10"], title: "Model and mode mid-session", run: t10ModelMode },
  { ids: ["T11"], title: "Resume, same runner", run: t11Resume },
  { ids: ["T13"], title: "Agent crash", run: t13Crash },
  { ids: ["T14"], title: "Process-tree cleanup", run: t14Cleanup },
  { ids: ["T16"], title: "Resource use", run: t16Resources },
  { ids: ["STEER"], title: "HTTP API steering probe", run: steerProbe },
  { ids: ["T7-HTTP", "T5-HTTP"], title: "The fallback: T7 reject and T5 plan over OpenCode's HTTP API", run: httpFallback },
];
