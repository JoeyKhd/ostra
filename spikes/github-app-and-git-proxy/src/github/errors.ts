// Octokit throws RequestError with a numeric status. Narrowed by shape, so
// no transitive package is imported directly.
export const httpStatus = (err: unknown): number | undefined =>
  typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number' ? err.status : undefined;
