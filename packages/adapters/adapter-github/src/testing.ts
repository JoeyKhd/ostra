// A fake GitHub for tests outside this package: the panel's end-to-end stack points
// OSTRA_GITHUB_API_URL at one. Not part of the adapter's runtime surface.
export { createFakeGitHub } from "./fake-github.ts";
export type { FakeAccount, FakeCheckRun, FakeCompare, FakeGitHub, FakeGitHubUser, FakePullRequest, FakeRepo, FakeRequest, FakeReview, InjectedFailure } from "./fake-github.ts";
