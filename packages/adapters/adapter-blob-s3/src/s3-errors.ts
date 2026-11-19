import { adapterError } from "@ostra/adapter-sdk";
import type { AdapterError, Err } from "@ostra/adapter-sdk";
import { z } from "zod";

// The AWS SDK throws errors with a `name` (S3's error code) and `$metadata.httpStatusCode`. They are
// read by shape, as the GitHub adapter reads Octokit's, and mapped to ostra's own words: an error
// here never holds the store's message, a header, a key ID or a secret.

const s3ErrorSchema = z.looseObject({
  name: z.string().optional(),
  $metadata: z.looseObject({ httpStatusCode: z.number().optional() }).optional(),
});

const NOT_FOUND = new Set(["NoSuchKey", "NotFound", "NoSuchUpload"]);
const UNAUTHORIZED = new Set(["InvalidAccessKeyId", "SignatureDoesNotMatch", "ExpiredToken", "InvalidToken"]);
const THROTTLED = new Set(["SlowDown", "Throttling", "ThrottlingException", "RequestLimitExceeded", "TooManyRequestsException"]);

/** Whether a thrown error is S3 saying the key (or upload) isn't there. */
export const isNotFound = (error: unknown): boolean => {
  const parsed = s3ErrorSchema.safeParse(error);
  if (!parsed.success) {
    return false;
  }
  return (parsed.data.name !== undefined && NOT_FOUND.has(parsed.data.name)) || parsed.data.$metadata?.httpStatusCode === 404;
};

/** Maps whatever a call threw to an adapter error, in ostra's own words. */
export const toAdapterError = (operation: string, error: unknown): Err<AdapterError> => {
  const parsed = s3ErrorSchema.safeParse(error);
  const name = parsed.success ? parsed.data.name : undefined;
  const status = parsed.success ? parsed.data.$metadata?.httpStatusCode : undefined;
  const where = `${operation} failed${status === undefined ? "" : ` (HTTP ${String(status)})`}`;
  if (name === "NoSuchBucket") {
    return adapterError("unavailable", `${where}: the bucket does not exist`);
  }
  if (name !== undefined && NOT_FOUND.has(name)) {
    return adapterError("not-found", `${where}: not found`);
  }
  if ((name !== undefined && UNAUTHORIZED.has(name)) || status === 401) {
    return adapterError("unauthorized", `${where}: the store refused the access key`);
  }
  if (name === "AccessDenied" || status === 403) {
    return adapterError("forbidden", `${where}: the access key lacks a permission on the bucket`);
  }
  if ((name !== undefined && THROTTLED.has(name)) || status === 429 || status === 503) {
    return adapterError("rate-limited", `${where}: the store asks for fewer requests`);
  }
  if (status !== undefined && status >= 500) {
    return adapterError("unavailable", `${where}: the store is failing`);
  }
  if (status !== undefined) {
    return adapterError("invalid-input", where);
  }
  if (error instanceof Error && error.name === "AbortError") {
    return adapterError("aborted", `${operation} was cancelled`);
  }
  // No HTTP answer at all: a refused or reset connection, a timeout, a name that did not resolve.
  return adapterError("unavailable", `${operation} failed: the store could not be reached`);
};
