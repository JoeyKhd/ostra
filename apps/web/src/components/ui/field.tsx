import type { ReactNode } from "react";

import { Label } from "./label";

export type FieldProps = {
  readonly id: string;
  readonly label: string;
  readonly help?: ReactNode;
  readonly error?: string | null;
  readonly children: ReactNode;
};

/** A labelled form field with its help line and, when the server refused it, its error in words. */
export const Field = ({ id, label, help, error, children }: FieldProps) => (
  <div className="mb-3.5">
    <Label htmlFor={id}>{label}</Label>
    {children}
    {error !== undefined && error !== null ? (
      <p id={`${id}-error`} role="alert" className="mt-1.5 text-sm text-red">
        {error}
      </p>
    ) : help === undefined ? null : (
      <p className="mt-1.5 text-sm text-faint">{help}</p>
    )}
  </div>
);
