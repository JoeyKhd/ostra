"use client";

import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { Input } from "./input";

export type SecretFieldProps = {
  readonly id: string;
  /** Whether a value is stored. The value itself never comes back to the browser. */
  readonly set: boolean;
  /** `null` while the stored value is kept; a string while one is typed. */
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
  readonly disabled?: boolean;
  /** Locked or read-only: a stored secret shows `Set` with no `Replace`. */
  readonly readOnly?: boolean;
  readonly invalid?: boolean;
  readonly describedBy?: string;
  readonly className?: string;
};

/**
 * A secret, shown only as set or not set (ticket 37; email-settings.md, "A secret"): `✓ Set` and a
 * teal `Replace`, which turns into an empty password input and a teal `Cancel`. Not set, the empty
 * input directly with `Not set` as its hint. Leaving it empty keeps the stored one.
 */
export const SecretField = ({ id, set, value, onChange, disabled = false, readOnly = false, invalid = false, describedBy, className }: SecretFieldProps) => {
  if (set && value === null) {
    return (
      <span className={cn("flex h-8 items-center gap-3 text-ui", className)}>
        <span className="flex items-center gap-1.5 text-text">
          <CheckIcon aria-hidden className="size-[14px] stroke-[1.75] text-green" />
          {t("secret.set")}
        </span>
        {readOnly ? null : (
          <button
            type="button"
            disabled={disabled}
            className="text-teal hover:text-text disabled:opacity-50"
            onClick={() => {
              onChange("");
            }}
          >
            {t("secret.replace")}
          </button>
        )}
      </span>
    );
  }
  const hint = `${id}-hint`;
  return (
    <span className={cn("flex min-w-0 items-center gap-3", className)}>
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        className="h-8 min-w-0 flex-1 font-mono text-[12.5px] sm:w-[320px] sm:flex-none"
        value={value ?? ""}
        disabled={disabled || readOnly}
        aria-invalid={invalid}
        aria-describedby={[set ? null : hint, describedBy ?? null].filter((part) => part !== null).join(" ") || undefined}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {set ? (
        <button
          type="button"
          disabled={disabled}
          className="shrink-0 text-ui text-teal hover:text-text disabled:opacity-50"
          onClick={() => {
            onChange(null);
          }}
        >
          {t("common.cancel")}
        </button>
      ) : (
        <span id={hint} className="shrink-0 text-ui text-faint">
          {t("secret.notSet")}
        </span>
      )}
    </span>
  );
};
