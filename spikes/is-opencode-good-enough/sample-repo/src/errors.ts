export type CalcErrorCode = "syntax" | "unknown-name" | "arity" | "domain";

/** The only error the calculator throws for bad input. Anything else is a bug. */
export class CalcError extends Error {
  readonly code: CalcErrorCode;

  constructor(code: CalcErrorCode, message: string) {
    super(message);
    this.name = "CalcError";
    this.code = code;
  }
}
