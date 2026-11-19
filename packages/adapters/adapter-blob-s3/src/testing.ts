// A fake S3-compatible server for tests outside this package: core's tests point the blob service at
// one. Not part of the adapter's runtime surface.
export { createFakeS3 } from "./fake-s3.ts";
export type { FakeS3, FakeS3Fault, FakeS3Object, FakeS3Options, FakeS3Request } from "./fake-s3.ts";
