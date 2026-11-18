/** What a blob store adapter can do (ADR 0025, ADR 0043). */
export type BlobStoreCapabilities = {
  /** Uploads can be chunked and resumed after a drop, with a digest (session archives, files). */
  readonly resumableUpload: boolean;
};
