import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { RouterOutputs } from "@/lib/trpc";

import { EntityCell, EntityChipText, EntryPanel } from "./audit-view";

// F-073 (audit-log.md): the audit log's Entity column, panel and chip draw what the entity is called,
// the API's `entityLabel`, and never a short ID while there's a label.

type Entry = RouterOutputs["audit"]["list"]["entries"][number];

const TASK_ID = "0196f1a0-5b2c-7d3e-8f40-123456789abc";
const POOL_ID = "0196f1a0-aaaa-7d3e-8f40-0000000000bb";

const entry = (over: Partial<Entry>): Entry => ({
  id: "0196f1a0-0000-7000-8000-000000000001",
  at: Date.UTC(2026, 10, 19, 14, 7, 33),
  actor: { kind: "member", id: "m-1", name: "Sam Rivera", removed: false },
  action: "task.created",
  entity: "task",
  entityId: TASK_ID,
  entityLabel: "CALC-161",
  taskId: TASK_ID,
  project: null,
  data: { kind: "code" },
  ...over,
});

const noop = () => undefined;

describe("the audit log's entity (F-073)", () => {
  it("F-073/c2: the Entity column shows the kind and the entity's label, not its ID", () => {
    const task = renderToStaticMarkup(<EntityCell entry={entry({})} />);
    expect(task).toContain(">task<");
    expect(task).toContain(">CALC-161<");
    expect(task).not.toContain("0196f1a0");
    expect(task).toContain("font-mono");
    const pool = renderToStaticMarkup(<EntityCell entry={entry({ entity: "runner-pool", entityId: POOL_ID, entityLabel: "build-pool" })} />);
    expect(pool).toContain(">pool<");
    expect(pool).toContain(">build-pool<");
    const member = renderToStaticMarkup(<EntityCell entry={entry({ entity: "member", entityId: "m-2", entityLabel: "Rae Okafor" })} />);
    expect(member).toContain(">Rae Okafor<");
    expect(member).not.toContain("font-mono");
    expect(renderToStaticMarkup(<EntityCell entry={entry({ entity: null, entityId: null, entityLabel: null })} />)).toContain("—");
  });

  it("F-073/c2: the panel names the entity as Task CALC-161, linked to its page, and Entries about this pool by the kind's word", () => {
    const task = renderToStaticMarkup(<EntryPanel entry={entry({})} onEntity={noop} />);
    expect(task).toMatch(/data-testid="audit-entity-link"[^>]*>Task <span[^>]*>CALC-161<\/span><\/a>/);
    expect(task).toContain(`href="/tasks/${TASK_ID}"`);
    expect(task).toContain("Entries about this task");
    const pool = renderToStaticMarkup(
      <EntryPanel entry={entry({ action: "runner-pool.created", entity: "runner-pool", entityId: POOL_ID, entityLabel: "build-pool", taskId: null })} onEntity={noop} />,
    );
    expect(pool).toContain('href="/organization/runners"');
    expect(pool).toContain(">build-pool<");
    expect(pool).toContain("Entries about this pool");
    expect(pool).not.toContain("0196f1a0-aaaa");
  });

  it("F-073/c2: the entity filter's chip reads the label an entry about it carries, and its short ID before any is listed", () => {
    expect(renderToStaticMarkup(<EntityChipText entity="task" entityId={TASK_ID} entries={[entry({})]} />)).toContain(">CALC-161<");
    const unlisted = renderToStaticMarkup(<EntityChipText entity="task" entityId={TASK_ID} entries={[]} />);
    expect(unlisted).toContain(">0196f1a0…<");
    expect(unlisted).toContain(">task<");
  });
});
