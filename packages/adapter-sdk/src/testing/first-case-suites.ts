import { describe } from "vitest";

import type { BlobStoreAdapter } from "../blob-store/base.ts";
import type { NotificationAdapter } from "../notification/base.ts";
import type { TrackerAdapter } from "../tracker/base.ts";
import { defineCommonCases, useSubject } from "./common-cases.ts";
import type { ContractSuiteOptions } from "./common-cases.ts";

// The suites of the kinds milestone 1 doesn't implement, with their first cases: the name, the
// kind, every capability declared, and a healthy check. Each grows with its first adapter: the
// tracker's with Linear (milestone 2), the blob store's with session archives (milestone 2), the
// notification's with the panel and email (milestone 3).

export const defineTrackerContractSuite = <Fixture>(options: ContractSuiteOptions<TrackerAdapter, Fixture>): void => {
  describe(`tracker contract: ${options.name}`, () => {
    defineCommonCases(useSubject(options), "tracker", {
      agentSessions: "boolean",
      subIssues: "boolean",
      statusGraph: "boolean",
    });
  });
};

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
