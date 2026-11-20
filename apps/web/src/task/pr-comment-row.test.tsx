import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PrCommentRow } from "./renderers";
import { createTaskIndexStore, TaskContext } from "./task-context";
import type { TaskContextValue } from "./task-context";

// F-111 (ticket 38): an accepted `@ostra` comment is a thread row with "Remember this", where the
// page can propose. Clicking it and the proposal are the browser's (`e2e/15-memory.spec.ts`).

const data = { seq: 7, url: "https://github.com/fake-org/test1/pull/3#issuecomment-31", login: "ostra-test-member", path: "src/add.ts", line: 12 };
const base: TaskContextValue = { store: createTaskIndexStore(), memberName: () => "", agent: { name: "OpenCode", model: null }, approvalSummary: () => null };
const render = (context: TaskContextValue): string =>
  renderToStaticMarkup(
    <TaskContext.Provider value={context}>
      <PrCommentRow data={data} />
    </TaskContext.Provider>,
  );

describe("an accepted @ostra comment in the thread (F-111)", () => {
  it("F-111/c1: the row names the commenter, the line and the comment's link, with Remember this where the page can propose", () => {
    const html = render({ ...base, rememberPrComment: () => Promise.resolve({ kind: "proposed" }) });
    expect(html).toContain('data-part="pr-comment"');
    expect(html).toContain("ostra-test-member asked through an @ostra comment on the pull request");
    expect(html).toContain("src/add.ts:12");
    expect(html).toContain(`href="${data.url}"`);
    expect(html).toContain('data-action="remember-this"');
    expect(render(base)).not.toContain("remember-this");
  });
});
