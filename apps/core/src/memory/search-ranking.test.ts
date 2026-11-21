import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { searchNotes } from "@ostra/domain";
import { noteIdSchema, organizationIdSchema, projectIdSchema } from "@ostra/protocol";
import type { MemoryKind, NoteId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// How `memory_search` ranks (F-110/c8, ADR 0044's 2026-11-21 note, borrowed from claude-mem: see
// `context/research/claude-mem.md`): against a project's realistic notes, a question an agent asks
// in plain words finds the note that answers it first, and so do the code-ish terms an agent copies
// from a log or a file (an identifier, a flag, a path). The notes hold the common words ("we",
// "do", "the", "run") that a search ranking every word alike is drawn to.

let test: TestDatabase;
let fixture: IsolationFixture;

type FixtureNote = { readonly key: string; readonly title: string; readonly body: string; readonly kind: MemoryKind };

const NOTES: readonly FixtureNote[] = [
  {
    key: "api-tests",
    title: "Run the API tests with pnpm test:api",
    body: "The API tests need the dev database: start it with `pnpm dev:db`, then run `pnpm test:api` from the repo root.",
    kind: "command",
  },
  {
    key: "windows-migration",
    title: "The migration fails on Windows without long paths",
    body: "Prisma's migrate step fails on Windows when the checkout's path is long. Turn long paths on (`git config core.longpaths true`), or clone closer to the drive's root.",
    kind: "gotcha",
  },
  {
    key: "core-url",
    title: "Point the runner at core",
    body: "Set `OSTRA_CORE_URL=http://localhost:3000` before `pnpm dev:runner`; the runner refuses to start without it.",
    kind: "command",
  },
  {
    key: "lockfile",
    title: "CI installs from the lockfile",
    body: "CI runs `pnpm install --frozen-lockfile`. A package.json change without its pnpm-lock.yaml fails every later build.",
    kind: "gotcha",
  },
  {
    key: "review",
    title: "We do code review on every pull request",
    body: "Do not merge your own pull request. We ask for one approval, and the reviewer opens the app when the change is visual. Do it before the end of the day if you can.",
    kind: "convention",
  },
  {
    key: "api-keys",
    title: "Where the API keys live",
    body: "The model provider's API key is in the secret store, never in a .env file. Ask an admin to rotate it.",
    kind: "convention",
  },
  {
    key: "parallel-tests",
    title: "Test files run side by side",
    body: "Vitest runs each package's test files at once; a test that needs the database copies the template database first, so tests never share one.",
    kind: "convention",
  },
  { key: "client", title: "Say client, not customer", body: "In the panel and the docs, the people who pay us are clients.", kind: "term" },
  {
    key: "add-first",
    title: "Migrations add first, drop later",
    body: "A migration only adds a column or a table. Drop or rename in a later release: other teams upgrade on their own schedule.",
    kind: "decision",
  },
  {
    key: "branches",
    title: "How we name branches",
    body: "Every task branch is ostra/<ticket>. Do not push to main directly: the reconcile finds a task's branch by this prefix.",
    kind: "convention",
  },
  {
    key: "git-bash",
    title: "Use Git Bash for the scripts on Windows",
    body: "The repo's scripts are POSIX shell. On Windows, run them in Git Bash, not cmd or PowerShell.",
    kind: "gotcha",
  },
  {
    key: "release",
    title: "How we cut a release",
    body: "We do releases on Tuesdays. First we run the changelog script, then we tag the commit and we push the tag. The CI builds the images and the docs. If the build fails, we do not tag it again: we fix forward and do the next patch release. The notes go in the GitHub release.",
    kind: "convention",
  },
  {
    key: "day-one",
    title: "What a new member does on day one",
    body: "On day one we do the setup together: we clone the repo, we run the dev database, we run the tests and we open the panel. Then we pair on a small ticket. By the end of the day the new member has run the whole stack and knows where the docs are.",
    kind: "convention",
  },
  {
    key: "prisma-generate",
    title: "Regenerate the Prisma client after a schema change",
    body: "After editing packages/db/prisma/schema.prisma, run `pnpm turbo run generate` before the tests, or the types are stale.",
    kind: "command",
  },
];

const ids = new Map<string, NoteId>();
const keyOf = (noteId: NoteId): string => [...ids.entries()].find(([, id]) => id === noteId)?.[0] ?? noteId;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  for (const note of NOTES) {
    const row = await test.db.memoryNote.create({
      data: {
        organizationId: fixture.a.organization.id,
        projectId: fixture.a.openProject.id,
        scope: "project",
        title: note.title,
        body: note.body,
        kind: note.kind,
        sourceKind: "member",
        authorMemberId: fixture.a.admin.id,
      },
      select: { id: true },
    });
    ids.set(note.key, noteIdSchema.parse(row.id));
  }
});

afterAll(async () => {
  await test.dispose();
});

const found = async (query: string): Promise<readonly string[]> =>
  (
    await searchNotes(test.db, {
      organizationId: organizationIdSchema.parse(fixture.a.organization.id),
      projectId: projectIdSchema.parse(fixture.a.openProject.id),
      query,
      limit: 5,
    })
  ).map((result) => keyOf(result.noteId));

/** A query an agent asks, and the note that answers it, which must come first. */
const QUESTIONS: readonly (readonly [query: string, first: string])[] = [
  ["how do we run the api tests", "api-tests"],
  ["why does the migration fail on windows", "windows-migration"],
  ["OSTRA_CORE_URL", "core-url"],
  ["--frozen-lockfile", "lockfile"],
  ["what do we call the people who pay us", "client"],
  ["where is the model provider's api key", "api-keys"],
  ["schema.prisma", "prisma-generate"],
  ["how should we name a branch", "branches"],
  ["can I rename a column in a migration", "add-first"],
  ["do tests share the database", "parallel-tests"],
  ["what runs when I set OSTRA_CORE_URL", "core-url"],
  ["pnpm install --frozen-lockfile fails", "lockfile"],
];

describe("memory_search's ranking (F-110/c8)", () => {
  it.each(QUESTIONS)("F-110/c8: %j finds %s first", async (query, first) => {
    expect((await found(query))[0]).toBe(first);
  });

  it("F-110/c8: a short identifier still matches as a prefix, and only notes that hold it come back", async () => {
    // `pnpm` is in four notes' text; `pnpm-lock.yaml` and `dev:db` hold it too.
    expect([...(await found("pnpm"))].sort()).toEqual(["api-tests", "core-url", "lockfile", "prisma-generate"]);
    // "api" matches "API" as a word, in a title first.
    expect((await found("api")).slice(0, 2).sort()).toEqual(["api-keys", "api-tests"]);
    // A prefix of a word finds it: "migr" is how a hurried agent types "migration".
    expect(await found("migr")).toEqual(expect.arrayContaining(["windows-migration", "add-first"]));
  });

  it("F-110/c8: the common words of a question match nothing by themselves", async () => {
    expect(await found("how do we do it")).toEqual([]);
    // A note that holds only the question's common words, and none of its meaningful ones, isn't a result.
    expect(await found("how do we run the api tests")).not.toContain("review");
  });

  it("F-110/c8: a path, a flag and an identifier match as written, ahead of the notes that only share their words", async () => {
    // "prisma" alone is in two notes; the path is in one.
    expect((await found("packages/db/prisma/schema.prisma"))[0]).toBe("prisma-generate");
    expect((await found("prisma/schema.prisma"))[0]).toBe("prisma-generate");
    expect((await found("--frozen-lockfile"))[0]).toBe("lockfile");
    // "core" is in three notes ("core.longpaths" among them); the identifier is in one.
    expect((await found("OSTRA_CORE_URL"))[0]).toBe("core-url");
    expect((await found("core.longpaths"))[0]).toBe("windows-migration");
    expect((await found("test:api"))[0]).toBe("api-tests");
  });
});
