// What every use case shares (ticket 08). A use case takes its transaction or its ports and
// returns a result union for the failures a caller expects; it throws only for bugs. The bodies
// are written by the tickets each file names.

export type UseCaseResult<T, E extends string> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly error: E; /** For a person, never content. */ readonly message: string };

/** The body of a use case whose ticket hasn't written it yet. */
export const notImplemented = (ticket: string): never => {
  throw new Error(`not implemented: ticket ${ticket}`);
};

/**
 * What a milestone 2 use case answers until the ticket that writes its body lands: a rejected
 * promise naming that ticket. The signature is the contract; callers can be written against it.
 */
export const notYet = (ticket: string): Promise<never> => Promise.reject(new Error(`not implemented yet: ticket ${ticket}`));
