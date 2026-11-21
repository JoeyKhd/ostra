"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenIcon, CheckIcon, CircleXIcon, DownloadIcon, FileCodeIcon, FileTextIcon, KeyRoundIcon, LockIcon, PackageIcon, PlugIcon, ShieldPlusIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { useShellActions } from "@/components/shell/actions/shell-actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip } from "@/components/ui/status";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import {
  inputKindText,
  libraryNameOf,
  lookOrigin,
  lookSubject,
  missingInputs,
  ownerEntryOf,
  scriptChip,
  serverInputsOf,
  serverReference,
  serverRefusalOf,
  sizeText,
  skillReference,
  skillRowsOf,
  versionText,
} from "./library-model";
import type { LibraryItem, Look, ServerLook, SkillLook, SkillRow } from "./library-model";
import { focusBack, HashText, Note, SheetSection } from "./library-parts";

// "Add from a source" (F-145; app-targets/m8/library-install.md): the right sheet, 560 wide, that
// looks a reference up through the server and installs what it found, pinned. A skill: the repo's
// skills to pick, the commit, each file with its size, the scripts pointed out, the hash, and the
// allowlist with "Allow this source". A server: the registry entry's version and remote, its
// inputs (a secret one masked and never shown again), and after the install the test call's tools,
// or the OAuth mark. Nothing is installed until Install, and nothing is attached to a profile.

export type InstallKind = "skill" | "mcp";

export type SheetOrigin = { readonly kind: "suggestion"; readonly suggestionId: string; readonly member: string } | { readonly kind: "marketplace"; readonly host: string } | null;

export type AddFromSourceProps = {
  readonly open: boolean;
  readonly kind: InstallKind;
  /** The reference filled in, from a suggestion or a marketplace result: looked up at once. */
  readonly source: string | null;
  readonly origin: SheetOrigin;
  readonly organization: string;
  readonly items: readonly LibraryItem[];
  readonly onKind: (kind: InstallKind) => void;
  readonly onClose: () => void;
  /** The button the focus goes back to when the sheet closes. */
  readonly returnFocusTo?: string;
  /** After an install: each item made, by ID and name, at its pin. */
  readonly onInstalled: (installed: readonly { readonly itemId: string; readonly name: string; readonly pin: string }[]) => void;
};

const label = "mb-1.5 block text-xs font-medium text-muted";
const help = "mt-1.5 text-[12.5px] text-faint";

/** The registry part of a server reference typed as `registry:name@url`, or `null`. */
const registriesOf = (entries: readonly { readonly kind: string; readonly value: string }[]): readonly string[] => [...new Set(entries.filter((entry) => entry.kind === "registry").map((entry) => entry.value))];

const hostOf = (url: string): string => (URL.canParse(url) ? new URL(url).host : url);

/** The source field's text from a reference: a server's name without `registry:` and its registry. */
const sourceFieldOf = (kind: InstallKind, source: string | null): { readonly text: string; readonly registry: string | null } => {
  if (source === null) return { text: "", registry: null };
  if (kind === "mcp" && source.startsWith("registry:")) {
    const rest = source.slice("registry:".length);
    const at = rest.indexOf("@");
    return at === -1 ? { text: rest, registry: null } : { text: rest.slice(0, at), registry: rest.slice(at + 1) };
  }
  return { text: source, registry: null };
};

export const AddFromSourceSheet = (props: AddFromSourceProps) => (
  <Sheet open={props.open} onOpenChange={(open) => { if (!open) props.onClose(); }}>
    {props.open ? <SheetBody {...props} /> : null}
  </Sheet>
);

const SheetBody = ({ kind, source, origin, organization, items, onKind, onClose, onInstalled, returnFocusTo }: AddFromSourceProps) => {
  const id = useId();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { announce } = useShellActions();
  const sources = useQuery(trpc.library.sources.list.queryOptions());
  const registries = useMemo(() => registriesOf(sources.data ?? []), [sources.data]);
  const initial = sourceFieldOf(kind, source);
  const [text, setText] = useState(initial.text);
  const [ref, setRef] = useState("");
  const [registry, setRegistry] = useState<string | null>(initial.registry);
  const [look, setLook] = useState<Look | null>(null);
  const [lookedFor, setLookedFor] = useState<string | null>(null);
  const [allowedNow, setAllowedNow] = useState(false);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [readOnly, setReadOnly] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [serverDone, setServerDone] = useState<{ readonly itemId: string; readonly name: string; readonly pin: string; readonly tools: readonly string[] | null; readonly needsOAuth: boolean; readonly testError: string | null } | null>(null);
  const [viewing, setViewing] = useState<{ readonly path: string; readonly text: string | null; readonly error: string | null } | null>(null);
  const chosenRegistry = registry ?? registries[0] ?? null;

  const resolve = useMutation(trpc.library.resolve.mutationOptions());
  const allow = useMutation(trpc.library.sources.add.mutationOptions());
  const install = useMutation(trpc.library.install.mutationOptions());
  const testServer = useMutation(trpc.library.testServer.mutationOptions());
  const setReadOnlyMark = useMutation(trpc.library.setReadOnly.mutationOptions());
  const lookFile = useMutation(trpc.library.lookFile.mutationOptions());

  const reference = kind === "skill" ? skillReference(text, ref) : serverReference(text, chosenRegistry);
  const lookUp = (): void => {
    if (text.trim() === "") return;
    setLook(null);
    setInstallError(null);
    setAllowedNow(false);
    resolve.mutate(
      { reference },
      {
        onSuccess: (found) => {
          setLook(found);
          setLookedFor(reference);
          if (found.resolved.kind === "skills") {
            const rows = skillRowsOf(found.resolved, items);
            const installable = rows.filter((row) => row.problem === null && row.inLibrary === null);
            setPicked(installable.length === 1 || found.resolved.skills.length === 1 ? installable.map((row) => row.folder) : []);
            setShown(rows[0]?.folder ?? null);
          }
        },
      },
    );
  };
  // A reference handed in (a suggestion, a marketplace result) is looked up at once.
  const autoLooked = useRef(false);
  const ready = source !== null && text !== "" && (kind === "skill" || !sources.isPending);
  useEffect(() => {
    if (autoLooked.current || !ready) return;
    autoLooked.current = true;
    lookUp();
    // Once, when the reference handed in can be looked up.
  }, [ready]);

  const resolved = look?.resolved ?? null;
  const allowed = resolved === null ? false : resolved.allowed.allowed || allowedNow;
  const addEntry = (entry: Parameters<typeof allow.mutate>[0]["entry"]): void => {
    allow.mutate(
      { entry },
      {
        onSuccess: () => {
          setAllowedNow(true);
          void queryClient.invalidateQueries({ queryKey: trpc.library.sources.list.queryKey() });
        },
      },
    );
  };

  const afterInstall = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: trpc.library.pathKey() });
  };

  const installSkills = async (look: SkillLook, rows: readonly SkillRow[]): Promise<void> => {
    setInstallError(null);
    const made: { itemId: string; name: string; pin: string }[] = [];
    for (const row of rows.filter((candidate) => picked.includes(candidate.folder))) {
      try {
        const result = await install.mutateAsync({ kind: "skill", reference: lookedFor ?? reference, folder: row.folder, commit: look.commit, computedHash: row.skill.computedHash, allowSource: false });
        made.push({ itemId: result.itemId, name: row.name, pin: look.commit?.slice(0, 7) ?? row.skill.computedHash.slice(0, 7) });
      } catch (error) {
        setInstallError(errorText(error instanceof Error ? { message: error.message, data: dataOf(error) } : null) ?? t("errors.unknown"));
        break;
      }
    }
    await afterInstall();
    if (made.length > 0 && made.length === picked.length) {
      const [first] = made;
      announce(made.length === 1 && first !== undefined ? t("library.install.installedOne", { name: first.name, pin: first.pin }) : t("library.install.installedMany", { n: made.length }));
      onInstalled(made);
    }
  };

  const installServer = async (look: ServerLook): Promise<void> => {
    setInstallError(null);
    const inputs = serverInputsOf(look.inputs, values);
    try {
      const result = await install.mutateAsync({ kind: "server", reference: lookedFor ?? reference, version: look.version, variables: inputs.variables, headers: inputs.headers, allowSource: false });
      const name = libraryNameOf(look.name);
      if (readOnly) await setReadOnlyMark.mutateAsync({ itemId: result.itemId, readOnly: true });
      // The secret typed is gone from the page once it's stored.
      setValues({});
      let done: { tools: readonly string[] | null; needsOAuth: boolean; testError: string | null } = { tools: null, needsOAuth: false, testError: null };
      try {
        const tested = await testServer.mutateAsync({ itemId: result.itemId });
        done = { tools: tested.toolNames, needsOAuth: tested.needsOAuth, testError: null };
      } catch (error) {
        done = { tools: null, needsOAuth: false, testError: errorText(error instanceof Error ? { message: error.message, data: dataOf(error) } : null) ?? t("errors.unknown") };
      }
      await afterInstall();
      setServerDone({ itemId: result.itemId, name, pin: versionText(look.version), ...done });
    } catch (error) {
      setInstallError(errorText(error instanceof Error ? { message: error.message, data: dataOf(error) } : null) ?? t("errors.unknown"));
    }
  };

  const skillRows = resolved?.kind === "skills" ? skillRowsOf(resolved, items) : [];
  const serverRefusal = resolved?.kind === "server" ? serverRefusalOf(resolved) : null;
  const missing = resolved?.kind === "server" ? missingInputs(resolved.inputs, values) : [];
  const busy = install.isPending || testServer.isPending;

  /** Why Install is off, in words, or `null`. */
  const offReason: { readonly icon: ReactNode; readonly text: string } | null = (() => {
    if (resolved === null) return null;
    if (resolved.kind === "server" && serverRefusal !== null) return { icon: <CircleXIcon aria-hidden />, text: t("library.install.nothingToInstall") };
    if (!allowed) return { icon: <LockIcon aria-hidden />, text: t("library.install.allowFirst") };
    if (resolved.kind === "skills" && picked.length === 0) return { icon: null, text: t("library.install.pickOne") };
    if (resolved.kind === "server" && missing.length > 0) return { icon: null, text: t("library.install.fillInputs", { names: missing.join(", ") }) };
    return null;
  })();
  const canInstall = resolved !== null && offReason === null && !busy && serverDone === null;
  const submit = (): void => {
    if (!canInstall) return;
    if (resolved.kind === "skills") void installSkills(resolved, skillRows);
    else void installServer(resolved);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };
  const onFieldKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      lookUp();
    }
  };

  const installLabel =
    resolved === null || serverRefusal !== null
      ? t("library.row.install")
      : resolved.kind === "server"
        ? t("library.install.installServer", { name: libraryNameOf(resolved.name) })
        : plural(Math.max(1, picked.length), "library.install.installSkillsOne", "library.install.installSkillsMany");

  return (
    <SheetContent title={t("library.install.title")} className="w-full sm:w-[min(560px,100vw)]" onKeyDown={onKeyDown} onCloseAutoFocus={focusBack(returnFocusTo)} data-testid="add-from-source">
      <div className="shrink-0 px-6 pt-5">
        <h2 className="text-[17px] font-semibold text-text">{t("library.install.title")}</h2>
        <p className="mt-0.5 text-[13.5px] text-muted">{t("library.install.lede", { organization })}</p>
        {origin === null ? null : (
          <p className="mt-0.5 text-sm text-faint" data-testid="install-origin">
            {origin.kind === "suggestion" ? t("library.install.suggestedBy", { name: origin.member }) : t("library.install.fromMarketplace", { host: origin.host })}
          </p>
        )}
        <ToggleGroup
          type="single"
          value={kind}
          onValueChange={(value) => {
            if (value === "skill" || value === "mcp") {
              onKind(value);
              setText("");
              setLook(null);
              setServerDone(null);
            }
          }}
          aria-label={t("library.install.kind")}
          className="mt-3 h-7"
        >
          <ToggleGroupItem value="skill" className="flex items-center gap-1.5 px-2.5 text-sm [&_svg]:size-[14px]"><BookOpenIcon aria-hidden /> {t("library.kind.skill")}</ToggleGroupItem>
          <ToggleGroupItem value="mcp" className="flex items-center gap-1.5 px-2.5 text-sm [&_svg]:size-[14px]"><PlugIcon aria-hidden /> {t("library.kind.server")}</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-3 pt-1">
        {kind === "skill" ? (
          <>
            <div className="mt-3 grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_132px]">
              <div className="min-w-0">
                <label htmlFor={`${id}-source`} className={label}>{t("library.install.source")}</label>
                <div className="relative">
                  <Input id={`${id}-source`} autoFocus value={text} onChange={(event) => { setText(event.target.value); }} onKeyDown={onFieldKey} placeholder={t("library.install.sourcePlaceholder")} spellCheck={false} className="h-[44px] pr-24 font-mono text-[13.5px] sm:h-8" data-testid="install-source" />
                  <Button size="sm" className="absolute right-1 top-1/2 -translate-y-1/2" onClick={lookUp} disabled={resolve.isPending || text.trim() === ""} data-action="look-up">
                    {resolve.isPending ? t("library.install.lookingUp") : t("library.install.lookUp")}
                  </Button>
                </div>
              </div>
              <div className="min-w-0">
                <label htmlFor={`${id}-ref`} className={label}>{t("library.install.ref")}</label>
                <Input id={`${id}-ref`} value={ref} onChange={(event) => { setRef(event.target.value); }} onKeyDown={onFieldKey} placeholder={t("library.install.refPlaceholder")} spellCheck={false} className="h-[44px] font-mono text-[13.5px] placeholder:font-sans placeholder:text-sm sm:h-8" />
              </div>
            </div>
            <p className={help}>{t("library.install.sourceHelp")}</p>
          </>
        ) : (
          <>
            <div className="mt-3 grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_170px]">
              <div className="min-w-0">
                <label htmlFor={`${id}-server`} className={label}>{t("library.install.serverName")}</label>
                <div className="relative">
                  <Input id={`${id}-server`} autoFocus value={text} onChange={(event) => { setText(event.target.value); }} onKeyDown={onFieldKey} placeholder={t("library.install.serverPlaceholder")} spellCheck={false} className="h-[44px] pr-24 font-mono text-[13.5px] sm:h-8" data-testid="install-server-name" />
                  <Button size="sm" className="absolute right-1 top-1/2 -translate-y-1/2" onClick={lookUp} disabled={resolve.isPending || text.trim() === ""} data-action="look-up">
                    {resolve.isPending ? t("library.install.lookingUp") : t("library.install.lookUp")}
                  </Button>
                </div>
              </div>
              <div className="min-w-0">
                <span className={label}>{t("library.install.libraryName")}</span>
                <p className="flex h-8 items-center truncate font-mono text-[13.5px] text-text" data-testid="install-library-name">{text.includes("/") ? libraryNameOf(text) : "—"}</p>
              </div>
            </div>
            <div className="mt-3">
              <span id={`${id}-registry`} className={label}>{t("library.install.registry")}</span>
              {registries.length === 0 ? (
                <p className="text-sm text-faint">{sources.isPending ? t("library.loading") : t("library.install.noRegistry")}</p>
              ) : (
                <Select value={chosenRegistry ?? ""} onValueChange={(value) => { setRegistry(value); setLook(null); }}>
                  <SelectTrigger className="h-[44px] w-full bg-surface sm:h-8" aria-labelledby={`${id}-registry`} data-testid="install-registry"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {registries.map((url) => (
                      <SelectItem key={url} value={url}>
                        <span className="font-mono text-sm">{hostOf(url)}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className={help}>{t("library.install.registryHelp", { organization })}</p>
            </div>
          </>
        )}

        <div aria-live="polite">
          {resolve.isPending ? (
            <div aria-busy className="mt-3 space-y-2">
              {[0, 1, 2].map((row) => <Skeleton key={row} className="h-[26px] w-full" />)}
            </div>
          ) : resolve.error === null ? null : (
            <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-red" data-testid="look-error">
              <CircleXIcon aria-hidden className="mt-[2px] size-[14px] shrink-0" />
              {errorText(resolve.error)}
            </p>
          )}
        </div>

        {resolved === null || resolve.isPending ? null : resolved.kind === "skills" ? (
          <SkillLookView
            look={resolved}
            refName={ref.trim() === "" ? "HEAD" : ref.trim()}
            rows={skillRows}
            allowed={allowed}
            picked={picked}
            shown={shown}
            onPick={(folder, on) => { setPicked((current) => (on ? [...current.filter((entry) => entry !== folder), folder] : current.filter((entry) => entry !== folder))); }}
            onShow={setShown}
            allowNote={
              allowed ? null : (
                <AllowNote
                  subject={lookSubject(resolved)}
                  organization={organization}
                  pending={allow.isPending}
                  error={allow.error === null ? null : errorText(allow.error)}
                  onAllow={() => { addEntry(resolved.entryToAllow); }}
                  wider={(() => {
                    const owner = ownerEntryOf(resolved);
                    return owner === null ? null : { label: t("library.install.wholeOwner"), onClick: () => { addEntry(owner); } };
                  })()}
                />
              )
            }
            onRead={(row, path) => {
              setViewing({ path, text: null, error: null });
              lookFile.mutate(
                { reference: lookedFor ?? reference, folder: row.folder, commit: resolved.commit, computedHash: row.skill.computedHash, path },
                {
                  onSuccess: (file) => { setViewing({ path, text: file.binary ? t("library.install.binaryFile", { size: sizeText(file.size) }) : (file.text ?? ""), error: null }); },
                  onError: (error) => { setViewing({ path, text: null, error: errorText(error) }); },
                },
              );
            }}
          />
        ) : (
          <ServerLookView
            look={resolved}
            allowed={allowed}
            refusal={serverRefusal}
            values={values}
            readOnly={readOnly}
            done={serverDone}
            onValue={(key, value) => { setValues((current) => ({ ...current, [key]: value })); }}
            onReadOnly={setReadOnly}
            allowNote={
              allowed ? null : (
                <AllowNote
                  subject={lookSubject(resolved)}
                  organization={organization}
                  pending={allow.isPending}
                  error={allow.error === null ? null : errorText(allow.error)}
                  onAllow={() => { addEntry(resolved.entryToAllow); }}
                  server
                  wider={{ label: t("library.install.wholeRegistry"), onClick: () => { addEntry({ kind: "registry", value: resolved.registryUrl, namespace: null }); } }}
                />
              )
            }
          />
        )}
      </div>

      <div className="shrink-0 border-t border-line px-6 pb-4 pt-3">
        {serverDone !== null ? (
          <>
            <p className="text-sm text-muted">{serverDone.needsOAuth ? t("library.install.doneMarked", { name: serverDone.name }) : t("library.install.doneServer", { name: serverDone.name, pin: serverDone.pin })}</p>
            <div className="mt-2.5 flex justify-end">
              <Button variant="primary" className="h-[44px] sm:h-[30px]" onClick={() => { onInstalled([{ itemId: serverDone.itemId, name: serverDone.name, pin: serverDone.pin }]); }} data-action="install-done">{t("library.install.done")}</Button>
            </div>
          </>
        ) : (
          <>
            {resolved === null ? null : (
              <p className="text-sm text-muted">
                {resolved.kind === "skills"
                  ? picked.length === 0
                    ? t("library.install.footerNone", { pin: resolved.commit?.slice(0, 7) ?? t("library.install.theHash") })
                    : t("library.install.footerSkill", { pin: resolved.commit?.slice(0, 7) ?? t("library.install.theHash"), n: skillRows.filter((row) => picked.includes(row.folder)).reduce((total, row) => total + row.files, 0) })
                  : serverRefusal === null
                    ? t("library.install.footerServer", { version: versionText(resolved.version) })
                    : t("library.install.refusedFooter")}
              </p>
            )}
            {installError === null ? null : <p role="alert" className="mt-1.5 text-sm text-red" data-testid="install-error">{installError}</p>}
            <div className="mt-2.5 flex items-center gap-2">
              {offReason === null ? null : (
                <span id={`${id}-off`} className="mr-auto flex min-w-0 items-center gap-1.5 text-sm text-faint [&_svg]:size-[14px] [&_svg]:shrink-0">{offReason.icon}{offReason.text}</span>
              )}
              <Button variant="ghost" className="ml-auto h-[44px] flex-1 sm:h-[30px] sm:flex-none" onClick={onClose}>{serverRefusal === null ? t("common.cancel") : t("common.close")}</Button>
              <Button
                variant="primary"
                className="h-[44px] flex-1 sm:h-[30px] sm:flex-none"
                disabled={!canInstall}
                aria-disabled={!canInstall}
                {...(offReason === null ? {} : { "aria-describedby": `${id}-off` })}
                onClick={submit}
                data-action="install"
              >
                <DownloadIcon aria-hidden />
                {busy ? t("library.install.installing") : installLabel}
              </Button>
            </div>
          </>
        )}
      </div>

      <Dialog.Root open={viewing !== null} onOpenChange={(open) => { if (!open) setViewing(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] bg-(--scrim)" />
          <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-[60] flex max-h-[80vh] w-[min(720px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[10px] border border-line-2 bg-raise shadow-(--shadow-pop)">
            <Dialog.Title className="border-b border-line px-4 py-3 font-mono text-sm text-text">{viewing?.path ?? ""}</Dialog.Title>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {viewing === null ? null : viewing.error !== null ? (
                <p role="alert" className="text-sm text-red">{viewing.error}</p>
              ) : viewing.text === null ? (
                <Skeleton className="h-24 w-full" />
              ) : (
                <ol className="font-mono text-[12.5px] leading-5 text-text-2" data-testid="script-viewer">
                  {viewing.text.split("\n").map((line, index) => (
                    <li key={index} className="grid grid-cols-[40px_minmax(0,1fr)] gap-3">
                      <span className="select-none text-right text-faint">{index + 1}</span>
                      <span className="whitespace-pre-wrap break-words">{line}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="flex justify-end border-t border-line px-4 py-2.5">
              <Dialog.Close asChild><Button>{t("common.close")}</Button></Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </SheetContent>
  );
};

/** A tRPC client error's `data`, read without trusting its shape. */
const dataOf = (error: Error): { readonly code?: string } | null => {
  const data: unknown = Reflect.get(error, "data");
  if (typeof data !== "object" || data === null) return null;
  const code: unknown = Reflect.get(data, "code");
  return typeof code === "string" ? { code } : null;
};

/** `{source} isn't on {organization}'s allowlist.` with `Allow this source` and the wider entry. */
const AllowNote = ({ subject, organization, pending, error, onAllow, wider, server = false }: {
  readonly subject: string;
  readonly organization: string;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onAllow: () => void;
  readonly wider: { readonly label: string; readonly onClick: () => void } | null;
  readonly server?: boolean;
}) => (
  <Note icon={<LockIcon aria-hidden />} className="mt-3" role="status">
    <p data-testid="allowlist-note">
      {server ? (
        t("library.install.notAllowedServer", { subject, organization })
      ) : (
        <>
          <span className="font-mono text-text">{subject}</span> {t("library.install.notAllowed", { organization })}
        </>
      )}
    </p>
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <Button size="sm" className="h-7" onClick={onAllow} disabled={pending} data-action="allow-source">
        <ShieldPlusIcon aria-hidden />
        {server ? t("library.install.allowNamespace") : t("library.install.allowSource")}
      </Button>
      <span className="text-[12.5px] text-faint">{server ? t("library.install.allowNamespaceHelp") : t("library.install.allowSourceHelp")}</span>
      {wider === null ? null : (
        <button type="button" className="text-[12.5px] text-teal hover:underline" onClick={wider.onClick} disabled={pending}>
          {wider.label}
        </button>
      )}
    </div>
    {error === null ? null : <p role="alert" className="mt-1.5 text-sm text-red">{error}</p>}
  </Note>
);

const SkillLookView = ({ look, refName, rows, allowed, picked, shown, onPick, onShow, allowNote, onRead }: {
  readonly look: SkillLook;
  /** The ref typed, or `HEAD`: the default branch's head. */
  readonly refName: string;
  readonly rows: readonly SkillRow[];
  readonly allowed: boolean;
  readonly picked: readonly string[];
  readonly shown: string | null;
  readonly onPick: (folder: string, on: boolean) => void;
  readonly onShow: (folder: string) => void;
  readonly allowNote: ReactNode;
  readonly onRead: (row: SkillRow, path: string) => void;
}) => {
  const open = rows.find((row) => row.folder === shown) ?? rows[0];
  const scripts = open?.skill.scripts ?? [];
  // A repo's look has a commit; a site's well-known index has none (library-install.md, part 4).
  const skillsTitle = look.commit === null ? t("library.install.skillsFound") : t("library.install.skillsInRepo");
  return (
    <div data-testid="skill-look">
      <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-sm text-muted" data-testid="look-resolved">
        <CheckIcon aria-hidden className="size-[14px] text-green" />
        {look.commit === null ? (
          <span>{t("library.install.siteRead", { n: look.skills.length })}</span>
        ) : (
          <span>
            <span className="font-mono text-text">{refName}</span> {t("library.install.is")} <span className="font-mono text-text" data-testid="look-commit">{look.commit.slice(0, 7)}</span>
          </span>
        )}
        <span className="text-faint">· {lookOrigin(look)}</span>
      </p>
      {allowed ? null : allowNote}

      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{t("library.install.noSkill", { at: look.commit?.slice(0, 7) ?? "" })}</p>
      ) : (
        <SheetSection title={skillsTitle} count={rows.length} note={look.commit === null ? undefined : t("library.install.skillsFoundNote", { commit: look.commit.slice(0, 7) })}>
          <ul role="group" aria-label={skillsTitle}>
            {rows.map((row) => {
              const disabled = row.problem !== null || row.inLibrary !== null;
              const checked = picked.includes(row.folder);
              return (
                <li
                  key={row.folder}
                  className={cn("grid grid-cols-[16px_minmax(0,1fr)_auto] gap-x-3 rounded-[6px] border-b border-line px-2 py-2", open?.folder === row.folder && "bg-sel")}
                  data-skill-row={row.name}
                  onClick={() => { onShow(row.folder); }}
                  onFocus={() => { onShow(row.folder); }}
                >
                  <Checkbox tone="teal" className="mt-[3px] size-4" checked={checked} disabled={disabled} aria-label={row.name} onCheckedChange={(state) => { onPick(row.folder, state === true); }} />
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className={cn("truncate font-mono text-ui font-medium", disabled && row.inLibrary === null ? "text-faint" : "text-text")}>{row.name}</span>
                      <span className="truncate font-mono text-[12px] text-faint">{row.folder}</span>
                    </span>
                    {row.problem !== null ? (
                      <span className="block text-sm text-red">{row.problem}</span>
                    ) : row.inLibrary !== null ? (
                      <span className="flex items-center gap-1.5 text-sm text-muted"><CheckIcon aria-hidden className="size-[13px] text-green" />{t("library.install.inLibrary", { pin: row.inLibrary })}</span>
                    ) : (
                      <span className="block truncate text-sm text-muted" title={row.description ?? undefined}>{row.description}</span>
                    )}
                  </span>
                  <span className="whitespace-nowrap font-mono text-[12px] text-faint">{row.problem === null ? `${plural(row.files, "library.install.filesOne", "library.install.filesMany")} · ${sizeText(row.size)}` : "—"}</span>
                </li>
              );
            })}
          </ul>
        </SheetSection>
      )}

      {open?.problem !== null ? null : (
        <>
          <SheetSection title={open.name} count={open.files} note={t("library.install.filesNote")}>
            <ul data-testid="look-files">
              {open.skill.files.map((file) => {
                const script = scripts.find((entry) => entry.path === file.path);
                return (
                  <li key={file.path} className="flex min-h-[26px] flex-wrap items-center gap-x-2 py-0.5 sm:flex-nowrap" data-file={file.path}>
                    {script === undefined ? <FileTextIcon aria-hidden className="size-[14px] shrink-0 text-faint" /> : <FileCodeIcon aria-hidden className="size-[14px] shrink-0 text-faint" />}
                    <span className="min-w-0 truncate font-mono text-sm text-text-2">{file.path}</span>
                    {script === undefined ? null : <Chip className="h-5 px-1.5 text-[11.5px]" >{scriptChip(script.reasons)}</Chip>}
                    <span className="ml-auto font-mono text-[12px] text-faint">{sizeText(file.size)}</span>
                  </li>
                );
              })}
            </ul>
            {scripts.length === 0 ? null : (
              <Note icon={<FileCodeIcon aria-hidden />} className="mt-2.5">
                {plural(scripts.length, "library.install.scriptsNoteOne", "library.install.scriptsNoteMany")}{" "}
                <button type="button" className="text-teal hover:underline" onClick={() => { const [first] = scripts; if (first !== undefined) onRead(open, first.path); }} data-action="read-script">
                  {t("library.install.readScript", { path: scripts[0]?.path ?? "" })}
                </button>
              </Note>
            )}
          </SheetSection>
          <dl className="mt-3 grid grid-cols-[74px_minmax(0,1fr)] gap-y-1.5 text-sm">
            <dt className="text-muted">{t("library.install.checks")}</dt>
            <dd className="flex items-center gap-1.5 text-text"><CheckIcon aria-hidden className="size-[13px] text-green" />{t("library.install.checksOk")}</dd>
            <dt className="text-muted">{t("library.install.hash")}</dt>
            <dd className="min-w-0 text-text"><HashText hash={open.skill.computedHash} /> <span className="text-faint">· {t("library.install.hashNote")}</span></dd>
          </dl>
        </>
      )}
    </div>
  );
};

const ServerLookView = ({ look, allowed, refusal, values, readOnly, done, onValue, onReadOnly, allowNote }: {
  readonly look: ServerLook;
  readonly allowed: boolean;
  readonly refusal: ReturnType<typeof serverRefusalOf>;
  readonly values: Readonly<Record<string, string>>;
  readonly readOnly: boolean;
  readonly done: { readonly tools: readonly string[] | null; readonly needsOAuth: boolean; readonly testError: string | null; readonly name: string } | null;
  readonly onValue: (key: string, value: string) => void;
  readonly onReadOnly: (on: boolean) => void;
  readonly allowNote: ReactNode;
}) => {
  const id = useId();
  return (
    <div data-testid="server-look">
      <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-sm text-muted" data-testid="look-resolved">
        <CheckIcon aria-hidden className="size-[14px] text-green" />
        <span className="font-mono text-text">{versionText(look.version)}</span>
        <span className="text-faint">· {t("library.install.latestActive")}{allowed ? ` · ${t("library.install.namespaceAllowed", { namespace: `${look.name.split("/")[0] ?? ""}/*` })}` : ""}</span>
      </p>
      {look.description === null ? null : <p className="mt-1 text-sm text-muted">{look.description}</p>}
      {allowed ? null : allowNote}

      {refusal !== null ? (
        <Note icon={refusal.kind === "packages-only" ? <PackageIcon aria-hidden /> : <CircleXIcon aria-hidden />} tone={refusal.kind === "packages-only" ? "plain" : "error"} className="mt-3.5" role="alert">
          <p className="font-medium text-text" data-testid="install-refusal">{refusal.title}</p>
          <p className="mt-1">{refusal.body}</p>
          {refusal.kind === "packages-only" ? <p className="mt-2 text-sm text-muted">{t("library.refusal.packagesByHand")}</p> : null}
        </Note>
      ) : (
        <>
          <SheetSection title={t("library.install.remote")} note={t("library.install.remoteNote")}>
            <RadioGroup value="remote" aria-label={t("library.install.remote")}>
              <label className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-3 rounded-[6px] bg-sel px-2 py-2">
                <RadioGroupItem value="remote" className="mt-[3px]" />
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <Chip className="h-5 shrink-0 px-1.5 text-[11.5px] text-text-2">{t("library.install.streamableHttp")}</Chip>
                    <span className="truncate font-mono text-sm text-text">{look.remoteUrl}</span>
                  </span>
                  <span className="mt-0.5 block text-[12.5px] text-faint">{t("library.install.remoteHelp")}</span>
                </span>
              </label>
            </RadioGroup>
          </SheetSection>

          {look.inputs.length === 0 ? null : (
            <SheetSection title={t("library.install.inputs")} count={look.inputs.length}>
              <div className="space-y-2">
                {look.inputs.map((input) => {
                  const key = `${input.kind}:${input.name}`;
                  return (
                    <div key={key} className="grid gap-x-3 gap-y-1 sm:grid-cols-[150px_minmax(0,1fr)]" data-input={input.name}>
                      <label htmlFor={`${id}-${key}`} className="min-w-0">
                        <span className="block truncate font-mono text-sm text-text">{input.name}</span>
                        <span className="block text-[11.5px] text-faint">{inputKindText(input)}{input.isRequired ? "" : ` · ${t("library.install.optional")}`}</span>
                      </label>
                      <div className="min-w-0">
                        <div className="relative">
                          <Input
                            id={`${id}-${key}`}
                            type={input.isSecret ? "password" : "text"}
                            autoComplete={input.isSecret ? "new-password" : "off"}
                            value={values[key] ?? ""}
                            disabled={done !== null}
                            placeholder={done !== null && input.isSecret ? t("library.install.secretStored") : ""}
                            onChange={(event) => { onValue(key, event.target.value); }}
                            className={cn("h-[44px] font-mono text-[13.5px] sm:h-8", input.isSecret && "pr-20")}
                            data-testid={input.isSecret ? "secret-input" : undefined}
                          />
                          {input.isSecret ? (
                            <Chip className="pointer-events-none absolute right-1.5 top-1/2 h-5 -translate-y-1/2 px-1.5 text-[11.5px]"><LockIcon aria-hidden />{t("library.install.secret")}</Chip>
                          ) : null}
                        </div>
                        {input.isSecret ? <p className={help}>{t("library.install.secretHelp")}</p> : input.description === null ? null : <p className={help}>{input.description}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </SheetSection>
          )}

          <SheetSection title={t("library.install.testCall")}>
            {done === null ? (
              <p className="text-sm text-faint">{t("library.install.testAfter")}</p>
            ) : done.needsOAuth ? (
              <Note icon={<KeyRoundIcon aria-hidden />} role="status">
                <p className="font-medium text-text" data-testid="install-oauth">{t("library.refusal.oauthTitle", { name: done.name })}</p>
                <p className="mt-1">{t("library.refusal.oauthBody")}</p>
              </Note>
            ) : done.testError !== null ? (
              <p role="alert" className="flex items-start gap-2 text-sm text-red"><CircleXIcon aria-hidden className="mt-[2px] size-[14px] shrink-0" />{done.testError}</p>
            ) : (
              <div data-testid="test-call">
                <p className="flex items-center gap-1.5 text-sm text-muted">
                  <CheckIcon aria-hidden className="size-[14px] text-green" />
                  {plural(done.tools?.length ?? 0, "library.install.toolsOne", "library.install.toolsMany")}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {(done.tools ?? []).map((tool) => <span key={tool} className="rounded-sm border border-line-2 px-2 py-0.5 font-mono text-[12px] text-text-2" data-tool={tool}>{tool}</span>)}
                </div>
              </div>
            )}
          </SheetSection>

          <div className="mt-4 flex items-start gap-3">
            <Switch id={`${id}-ro`} checked={readOnly} disabled={done !== null} onCheckedChange={onReadOnly} className="mt-0.5" />
            <div>
              <label htmlFor={`${id}-ro`} className="text-ui text-text">{t("library.install.readOnly")}</label>
              <p className="mt-0.5 text-[12.5px] text-faint">{t("library.install.readOnlyHelp")}</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

