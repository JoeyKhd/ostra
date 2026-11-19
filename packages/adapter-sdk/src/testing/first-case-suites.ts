import { describe } from "vitest";

import type { NotificationAdapter } from "../notification/base.ts";
import { defineCommonCases, useSubject } from "./common-cases.ts";
import type { ContractSuiteOptions } from "./common-cases.ts";

// The suites of the kinds whose operations aren't all built yet, with their first cases: the
// name, the kind, every capability declared, and a healthy check. The tracker's full suite is in
// `tracker-suite.ts` and the blob store's in `blob-store-suite.ts` (milestone 2), each with its
// first cases there. The notification's grows with the panel and email (milestone 3).

export const defineNotificationContractSuite = <Fixture>(
  options: ContractSuiteOptions<NotificationAdapter, Fixture>,
): void => {
  describe(`notification contract: ${options.name}`, () => {
    defineCommonCases(useSubject(options), "notification", { channels: "array" });
  });
};

