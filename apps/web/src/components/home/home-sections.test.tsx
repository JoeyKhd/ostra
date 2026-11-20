import { needsYouItemIdSchema, projectIdSchema, taskIdSchema } from "@ostra/protocol";
import { isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NeedsYouSection } from "./home-sections";
import { amberRow, needsYouRowKey } from "./home-words";
import type { NeedsYouDetail, NeedsYouRow } from "./home-words";

// F-062, F-036: Home's Needs you rows are one per item, not per task. A task can wait on an
// approval and a question at once, and each is its own row with its own React key: a key per task
// made React warn "Encountered two children with the same key" (Next's dev overlay: "1 Issue").

const now = Date.UTC(2026, 10, 20, 10, 0);
const taskId = taskIdSchema.parse("01a1f6b2-8878-76a8-9a31-e7d9ed2698de");

const row = (itemId: string | null, detail: NeedsYouDetail, since: number, task = taskId): NeedsYouRow => ({
  itemId: itemId === null ? null : needsYouItemIdSchema.parse(itemId),
  reason: detail.reason,
  state: "open",
  taskId: task,
  key: "CALC-7",
  title: "Two things at once",
  project: { id: projectIdSchema.parse("p-calc"), name: "calculator" },
  detail,
  since,
  driver: null,
  answer: null,
  outcome: null,
});

const approval = row("01a1f6b3-0000-7000-8000-000000000001", { reason: "approval", command: "pnpm add p-retry", subject: null, ruleName: null }, now - 120_000);
const question = row("01a1f6b3-0000-7000-8000-000000000002", { reason: "question", question: "Keep the old API?" }, now - 60_000);
const secondApproval = row("01a1f6b3-0000-7000-8000-000000000003", { reason: "approval", command: "pnpm test", subject: null, ruleName: null }, now - 30_000);

/** Every element under a node, depth first, without rendering a component: keys live on elements. */
const elementsIn = (node: ReactNode): readonly ReactElement[] => {
  const found: ReactElement[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (!isValidElement(current)) return;
    found.push(current);
    const props: unknown = current.props;
    if (typeof props === "object" && props !== null && "children" in props) visit(props.children);
  };
  visit(node);
  return found;
};

const hasTestId = (element: ReactElement, id: string): boolean => {
  const props: unknown = element.props;
  return typeof props === "object" && props !== null && "data-testid" in props && props["data-testid"] === id;
};

/** The React keys of the section's rows, as React reconciles them. */
const rowKeys = (rows: readonly NeedsYouRow[]): readonly (string | null)[] => {
  const tree = NeedsYouSection({ load: { kind: "ready", data: { total: rows.length, rows: [...rows] } }, now });
  const list = elementsIn(tree).find((element) => element.type === "ul" && hasTestId(element, "needs-you"));
  if (list === undefined) throw new Error("no needs-you list");
  const props: unknown = list.props;
  const children: unknown = typeof props === "object" && props !== null && "children" in props ? props.children : [];
  return (Array.isArray(children) ? children : [children]).flatMap((child: unknown) => (isValidElement(child) ? [child.key] : []));
};

describe("Home's Needs you rows", () => {
  it("F-062/c2, F-036/c2: two rows for one task have distinct keys, each its item's", () => {
    const keys = rowKeys([approval, question]);
    expect(keys).toEqual([approval.itemId, question.itemId]);
    expect(new Set(keys).size).toBe(2);

    const html = renderToStaticMarkup(<NeedsYouSection load={{ kind: "ready", data: { total: 2, rows: [approval, question] } }} now={now} />);
    expect([...html.matchAll(/data-testid="needs-you-row"/g)]).toHaveLength(2);
    expect([...html.matchAll(/data-item="([^"]+)"/g)].map((match) => match[1])).toEqual([approval.itemId, question.itemId]);
  });

  it("F-062/c2: a task from before items keys by its task, beside another task's items", () => {
    const before = row(null, { reason: "crashed" }, now - 10_000, taskIdSchema.parse("01a1f6b2-0000-7000-8000-00000000000b"));
    const keys = rowKeys([approval, before, question]);
    expect(keys).toEqual([approval.itemId, before.taskId, question.itemId]);
    expect(needsYouRowKey(before)).toBe(before.taskId);
  });

  it("F-062/c2: only the approval that waited longest is amber, not every row of its task", () => {
    expect(amberRow([question, secondApproval, approval])).toBe(approval.itemId);
    const html = renderToStaticMarkup(<NeedsYouSection load={{ kind: "ready", data: { total: 3, rows: [secondApproval, question, approval] } }} now={now} />);
    // One filled amber action (the section's amber dot is not a link).
    expect([...html.matchAll(/<a [^>]*bg-amber/g)]).toHaveLength(1);
  });
});
