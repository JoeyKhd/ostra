"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, CircleCheckIcon, CircleXIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, fieldClass } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatTokens } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterInputs, RouterOutputs } from "@/lib/trpc";

type Tested = RouterOutputs["providers"]["testConnection"];
type ApiFormat = RouterInputs["providers"]["create"]["apiFormat"];
type AuthScheme = RouterInputs["providers"]["create"]["authScheme"];

const formats: readonly ApiFormat[] = ["anthropic-messages", "openai-compatible"];

export const formatLabel = (format: ApiFormat): string =>
  format === "anthropic-messages" ? t("models.formatAnthropic") : t("models.formatOpenAi");

/**
 * Add a model provider (F-088): the base URL and token, "Test connection" (which detects the
 * format and lists the models, matched to the catalog), the format preselected and correctable,
 * the sessions cap, and "Allow on personal runners", off by default. The token is never shown
 * again once it's saved.
 */
export const AddProviderForm = ({ onCreated }: { readonly onCreated: (providerId: string) => void }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [apiFormat, setApiFormat] = useState<ApiFormat | null>(null);
  const [authScheme, setAuthScheme] = useState<AuthScheme>("bearer");
  const [cap, setCap] = useState("");
  const [allowPersonal, setAllowPersonal] = useState(false);
  const [tested, setTested] = useState<Tested | null>(null);

  const test = useMutation(
    trpc.providers.testConnection.mutationOptions({
      onSuccess: (result) => {
        setTested(result);
        if (result.ok) {
          setApiFormat(result.apiFormat);
          setAuthScheme(result.authScheme);
        }
      },
    }),
  );
  const create = useMutation(
    trpc.providers.create.mutationOptions({
      onSuccess: async ({ providerId }) => {
        setToken("");
        await queryClient.invalidateQueries({ queryKey: trpc.providers.list.queryKey() });
        await queryClient.invalidateQueries({ queryKey: trpc.setup.status.queryKey() });
        onCreated(providerId);
      },
    }),
  );

  const runTest = () => {
    setTested(null);
    test.mutate({ baseUrl: baseUrl.trim(), token, ...(apiFormat === null ? {} : { apiFormat }) });
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (apiFormat === null) return;
    const sessionsAtOnce = cap.trim() === "" ? null : Number.parseInt(cap, 10);
    create.mutate({
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      token,
      apiFormat,
      authScheme,
      sessionsAtOnce: sessionsAtOnce !== null && Number.isFinite(sessionsAtOnce) ? sessionsAtOnce : null,
      allowOnPersonalRunners: allowPersonal,
    });
  };

  const canTest = baseUrl.trim() !== "" && token !== "" && !test.isPending;
  const canSave = name.trim() !== "" && apiFormat !== null && tested?.ok === true && !create.isPending;

  return (
    <form onSubmit={submit} noValidate aria-label={t("models.addTitle")}>
      <p className="mb-1 text-xs font-medium text-faint">{t("models.addEyebrow")}</p>
      <h2 className="mb-1 text-[16.5px] font-semibold text-text">{t("models.addTitle")}</h2>
      <p className="mb-4 text-ui text-muted">{t("models.addLede")}</p>
      <Field id="provider-name" label={t("models.name")}>
        <Input id="provider-name" value={name} onChange={(e) => { setName(e.target.value); }} placeholder="anthropic" />
      </Field>
      <Field id="provider-url" label={t("models.baseUrl")}>
        <Input
          id="provider-url"
          className="font-mono"
          inputMode="url"
          spellCheck={false}
          value={baseUrl}
          onChange={(e) => { setBaseUrl(e.target.value); setTested(null); }}
          placeholder="https://api.example.com/v1"
        />
      </Field>
      <Field id="provider-token" label={t("models.token")} help={t("models.tokenHelp")}>
        <div className="relative">
          <Input
            id="provider-token"
            type={showToken ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            className="pr-9 font-mono"
            value={token}
            onChange={(e) => { setToken(e.target.value); setTested(null); }}
          />
          <button
            type="button"
            onClick={() => { setShowToken((v) => !v); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-text"
            aria-label={showToken ? t("models.hideToken") : t("models.showToken")}
          >
            {showToken ? <EyeOffIcon className="size-[14px]" /> : <EyeIcon className="size-[14px]" />}
          </button>
        </div>
      </Field>

      <div className="mb-4 flex items-center gap-2">
        <Button type="button" onClick={runTest} disabled={!canTest}>
          {test.isPending ? t("models.testing") : t("models.test")}
        </Button>
      </div>

      {test.error === null ? null : <p role="alert" className="mb-4 text-sm text-red">{errorText(test.error)}</p>}
      {tested === null ? null : <TestResult tested={tested} />}

      {tested?.ok === true ? (
        <>
          <Field id="provider-format" label={t("models.format")} help={t("models.formatHelp")}>
            <div className="relative">
            <select
              id="provider-format"
              className={cn(fieldClass, "h-[34px] appearance-none pr-8")}
              value={apiFormat ?? tested.apiFormat}
              onChange={(e) => {
                const next = formats.find((format) => format === e.target.value);
                if (next !== undefined) setApiFormat(next);
              }}
            >
              {formats.map((format) => (
                <option key={format} value={format}>
                  {formatLabel(format)}
                  {format === tested.apiFormat ? ` ${t("models.detected")}` : ""}
                </option>
              ))}
            </select>
            <ChevronDownIcon aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 size-[14px] -translate-y-1/2 stroke-[1.75] text-faint" />
            </div>
          </Field>
          <Field id="provider-cap" label={t("models.sessionsCap")} help={t("models.sessionsCapHelp")}>
            <Input id="provider-cap" inputMode="numeric" className="font-mono" value={cap} onChange={(e) => { setCap(e.target.value.replace(/\D/g, "")); }} placeholder={t("models.noCap")} />
          </Field>
          <PersonalRunnersSwitch id="provider-personal" checked={allowPersonal} onChange={setAllowPersonal} />
        </>
      ) : null}

      {create.error === null ? null : <p role="alert" className="mb-3 text-sm text-red">{errorText(create.error)}</p>}
      <Button type="submit" variant="primary" disabled={!canSave}>
        {create.isPending ? t("common.saving") : t("models.save")}
      </Button>
    </form>
  );
};

const TestResult = ({ tested }: { readonly tested: Tested }) => {
  if (!tested.ok) {
    return (
      <div role="alert" className="mb-4 flex items-start gap-2 text-sm text-red">
        <CircleXIcon className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
        <span>{tested.message}</span>
      </div>
    );
  }
  return (
    <div className="mb-4" data-testid="test-result">
      <div className="mb-2 flex items-center gap-2 text-ui text-green">
        <CircleCheckIcon className="size-[14px] shrink-0 stroke-[1.75]" />
        <span>
          {t("models.connected", { format: formatLabel(tested.apiFormat) })} · {plural(tested.models.length, "models.foundOne", "models.foundMany")}
        </span>
      </div>
      <ul className="rows max-h-56 overflow-y-auto text-sm">
        {tested.models.map((model) => (
          <li key={model.endpointModelId} className="flex h-[31px] items-center gap-3">
            <span className="min-w-0 max-w-[60%] shrink-0 truncate font-mono text-ui text-text" title={model.endpointModelId}>{model.endpointModelId}</span>
            <span className="min-w-0 flex-1 truncate text-faint">
              {model.match.kind === "catalog" ? model.match.name : t("models.custom")}
            </span>
            <span className="shrink-0 text-right font-mono text-faint">
              {formatTokens(model.match.kind === "catalog" ? model.match.contextWindow : model.contextWindow)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/** "Allow on personal runners": off by default, with the line that says why (F-014, Q47). */
export const PersonalRunnersSwitch = ({
  id,
  checked,
  onChange,
  disabled = false,
}: {
  readonly id: string;
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
  readonly disabled?: boolean;
}) => (
  <div className="mb-4">
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-body text-text">
        {t("models.allowPersonal")}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
    <p className="mt-1.5 text-sm text-faint">{t("models.allowPersonalHelp")}</p>
  </div>
);
