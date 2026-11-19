// A fake GitHub for tests outside this package: the panel's end-to-end stack points
// OSTRA_GITHUB_API_URL at one. Not part of the adapter's runtime surface.
export { createFakeGitHub } from "./fake-github.ts";
export type { FakeGitHub, FakePullRequest, FakeRepo, FakeRequest, InjectedFailure } from "./fake-github.ts";
