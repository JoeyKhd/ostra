import { describe } from "vitest";

import type { BlobStoreAdapter } from "../blob-store/base.ts";
import type { NotificationAdapter } from "../notification/base.ts";
import { defineCommonCases, useSubject } from "./common-cases.ts";
import type { ContractSuiteOptions } from "./common-cases.ts";

// The suites of the kinds whose operations aren't all built yet, with their first cases: the
// name, the kind, every capability declared, and a healthy check. The tracker's full suite is in
// `tracker-suite.ts` (milestone 2), and its first cases are `defineTrackerFirstCases` there. The
// notification's grows with the panel and email (milestone 3).

export const defineNotificationContractSuite = <Fixture>(
  options: ContractSuiteOptions<NotificationAdapter, Fixture>,
): void => {
  describe(`notification contract: ${options.name}`, () => {
    defineCommonCases(useSubject(options), "notification", { channels: "array" });
  });
};

export const defineBlobStoreContractSuite = <Fixture>(options: ContractSuiteOptions<BlobStoreAdapter, Fixture>): void => {
  describe(`blob store contract: ${options.name}`, () => {
    defineCommonCases(useSubject(options), "blob-store", { resumableUpload: "boolean" });
  });
};
