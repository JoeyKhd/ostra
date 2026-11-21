// Milestone 8 (F-145, F-146, ticket 31): loaded into the e2e panel's process only, before Next
// starts (`stack.ts` passes it as NODE_OPTIONS=--import). The library's calls out go through the
// server's `fetch`; this sends those for the API's fake hosts (a registry on the `v0.1` API, a stub
// MCP server, a site with the well-known skills index, skills.sh's search) to the in-memory fakes
// the API's own tests use, and every other https host off this machine to them too, where it's
// unreachable. So no spec reaches a real registry or skills.sh, and the panel's code is the one an
// install runs.

import { createFakeLibrary } from "@ostra/api/testing/library-fakes";

const fake = createFakeLibrary();

// The search answers with a skill of the fake GitHub's public skills repo (`fakes.ts`), so a result
// installs through the same look and install as a reference typed by hand.
fake.skillsSearch = {
  status: 200,
  results: [
    { source: "skills-org/skills", skillId: "writer", name: "writer", installs: 4200 },
    { source: "skills-org/skills", skillId: "review", name: "review", installs: 1830 },
    { source: "acme/skills", skillId: "release-notes", name: "release-notes", installs: 212 },
  ],
};

const real = globalThis.fetch;

/**
 * Whether a request goes to the fakes: the library's fake hosts, and any other https address off
 * this machine (GitHub's MCP registry, which every organization's list starts with, included), which
 * the fakes answer as unreachable. The stack's own services (core, the fake GitHub, the model stubs)
 * listen on loopback over http, and keep the real fetch.
 */
const faked = (input: string | URL | Request): boolean => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!URL.canParse(href)) return false;
  const url = new URL(href);
  return url.protocol === "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1";
};

globalThis.fetch = (input, init) => (faked(input) ? fake.fetch(input, init) : real(input, init));
