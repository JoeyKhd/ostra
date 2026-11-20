"use client";

import { KeyboardIcon } from "lucide-react";

import { themePreferences } from "@ostra/domain/theme";
import type { ThemePreference } from "@ostra/domain/theme";

import { useShellActions } from "@/components/shell/actions/shell-actions";
import { PropGroup, PropRow, Section } from "@/components/shell/page-frame";
import { useSystemScheme, useTheme } from "@/components/shell/theme-provider";
import type { ThemeFailure } from "@/components/shell/theme-provider";
import { Kbd } from "@/components/ui/kbd";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { ThemePreview } from "./theme-preview";

// Account, "Appearance" (account-appearance.md; F-082, ticket 18): dark, light or "match my system",
// as three cards with a preview each. Choosing repaints at once and saves to the account; a failed
// save puts the previous choice back and says so.

/** A choice's label: `Dark`, `Light`, `Match my system`. */
export const themeLabel = (theme: ThemePreference): string => {
  switch (theme) {
    case "dark":
      return t("account.appearance.dark");
    case "light":
      return t("account.appearance.light");
    case "system":
      return t("account.appearance.system");
    default:
      return theme satisfies never;
  }
};


export type ThemeChoiceProps = {
  readonly theme: ThemePreference;
  /** The system's scheme now, for "match my system"; `null` before the browser says. */
  readonly system: "dark" | "light" | null;
  readonly failure: ThemeFailure | null;
  readonly onChoose: (theme: ThemePreference) => void;
  readonly onShowShortcuts: () => void;
};

const isTheme = (value: string): value is ThemePreference => themePreferences.some((theme) => theme === value);

export const ThemeChoice = ({ theme, system, failure, onChoose, onShowShortcuts }: ThemeChoiceProps) => (
  <Section title={t("account.appearance.title")} note={t("account.appearance.note")}>
    <RadioGroup
      aria-label={t("account.appearance.choices")}
      value={theme}
      onValueChange={(value) => {
        if (isTheme(value)) onChoose(value);
      }}
      className="mt-2 grid gap-2 sm:grid-cols-[repeat(3,minmax(180px,236px))] sm:gap-[18px]"
      data-testid="theme-choice"
    >
      {themePreferences.map((choice) => {
        const selected = choice === theme;
        const id = `theme-${choice}`;
        return (
          <div key={choice} className="min-w-0">
            <label htmlFor={id} className="flex cursor-pointer items-center gap-3 max-sm:h-14 sm:block">
              <span
                aria-hidden
                className={cn(
                  "relative block shrink-0 overflow-hidden rounded-lg border border-line-2 max-sm:h-[46px] max-sm:w-[72px] max-sm:rounded-md sm:h-[148px]",
                  selected && "outline-2 outline-offset-[3px] outline-text",
                )}
                data-preview={choice}
              >
                <span className="absolute left-0 top-0 block h-[148px] w-[236px] origin-top-left max-sm:scale-[0.305]">
                  <ThemePreview theme={choice} />
                </span>
              </span>
              <span className="flex items-center gap-2 sm:mt-2.5">
                <RadioGroupItem id={id} value={choice} />
                <span className={cn("text-ui", selected ? "font-medium text-text" : "text-muted")}>{themeLabel(choice)}</span>
              </span>
            </label>
            {choice === "system" && selected && system !== null ? (
              <p className="mt-1.5 text-xs text-faint max-sm:pl-[84px] sm:pl-[22px]" data-testid="system-now">
                {t(system === "dark" ? "account.appearance.systemNow.dark" : "account.appearance.systemNow.light")}
              </p>
            ) : null}
          </div>
        );
      })}
    </RadioGroup>
    {failure === null ? null : (
      <p role="alert" className="mt-2.5 text-[12.5px] text-red">
        {t("account.appearance.failed", { error: failure.message.replace(/\.$/, ""), previous: t(`account.appearance.word.${failure.previous}`) })}
      </p>
    )}
    <p className="mt-3.5 flex flex-wrap items-center gap-1.5 text-xs text-faint max-sm:hidden">
      <KeyboardIcon aria-hidden className="size-[13px] stroke-[1.75]" />
      {t("account.appearance.press")}
      <Kbd className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-[4px] border border-line-2 bg-surface px-1 text-[11.5px] text-text">?</Kbd>
      {t("account.appearance.anywhere")}
      <button type="button" onClick={onShowShortcuts} className="ml-2.5 text-teal hover:underline">
        {t("account.appearance.shortcuts")}
      </button>
    </p>
    <div className="mt-5 border-b border-line" />
  </Section>
);

/** The properties panel's Appearance group: the choice, what "match my system" is now, and the sheet. */
export const AppearanceGroup = ({ theme, system, onShowShortcuts }: Pick<ThemeChoiceProps, "theme" | "system" | "onShowShortcuts">) => (
  <PropGroup title={t("account.panel.appearance")}>
    <PropRow label={t("account.panel.theme")} labelWidth={96}>
      <span className="truncate" data-testid="panel-theme">{themeLabel(theme)}</span>
    </PropRow>
    {theme === "system" && system !== null ? (
      <PropRow label={t("account.panel.now")} labelWidth={96}>
        {themeLabel(system)}
      </PropRow>
    ) : null}
    <PropRow label={t("account.panel.shortcuts")} labelWidth={96}>
      <button type="button" onClick={onShowShortcuts} className="text-teal hover:underline">
        {t("account.panel.showAll")}
      </button>
    </PropRow>
  </PropGroup>
);

/** The section, wired to the member's theme. */
export const AppearanceSection = () => {
  const { theme, choose, failure } = useTheme();
  const system = useSystemScheme();
  const { openSheet } = useShellActions();
  return <ThemeChoice theme={theme} system={system} failure={failure} onChoose={choose} onShowShortcuts={openSheet} />;
};

/** The panel's group, wired to the member's theme. */
export const AppearancePanelGroup = () => {
  const { theme } = useTheme();
  const system = useSystemScheme();
  const { openSheet } = useShellActions();
  return <AppearanceGroup theme={theme} system={system} onShowShortcuts={openSheet} />;
};
