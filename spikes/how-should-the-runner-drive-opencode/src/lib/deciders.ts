// Default answers for a driver with no member behind it: approve each tool once,
// decline each question. Shared by the harness and the child runner.

import type { ElicitationResponder, PermissionDecider } from "./acp-driver.ts";

export const allowOnce: PermissionDecider = (request) => {
  const option = request.options.find((o) => o.kind === "allow_once");
  return Promise.resolve(option === undefined ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: option.optionId } });
};

export const rejectOnce: PermissionDecider = (request) => {
  const option = request.options.find((o) => o.kind === "reject_once");
  return Promise.resolve(option === undefined ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: option.optionId } });
};

export const declineQuestions: ElicitationResponder = () => Promise.resolve({ action: "decline" });
