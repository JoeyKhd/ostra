"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, CheckIcon, TriangleAlertIcon } from "lucide-react";
import { AlertDialog as Dialog } from "radix-ui";
import { useState } from "react";
import type { ReactNode } from "react";

import { PageFrame, PageHeading, PropRow, Section } from "@/components/shell/page-frame";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatCount } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { canSave, confirmation, deletionLines, draftDays, draftOf, formatBytes } from "./storage-words";
import type { RetentionDraft } from "./storage-words";

export type Storage = RouterOutputs["organization"]["storage"];

const REFERENCE_URL = "https://github.com/JoeyKhd/ostra/blob/main/docs/configuration.md";
const MiB = 1024 * 1024;

const KeyRow = ({ label, children, end }: { readonly label: string; readonly children: ReactNode; readonly end?: ReactNode }) => (
  <li className="grid min-h-10 grid-cols-[140px_minmax(0,1fr)_auto] items-center gap-x-4 py-1.5 sm:grid-cols-[180px_minmax(0,1fr)_auto]">
    <span className="text-body text-muted">{label}</span>
    <span className="flex min-w-0 flex-wrap items-center gap-x-[74px] gap-y-0.5 text-body text-text">{children}</span>
    {end === undefined ? <span /> : <span className="shrink-0">{end}</span>}
  </li>
);

const Mono = ({ children, className }: { readonly children: ReactNode; readonly className?: string }) => <code className={cn("font-mono text-sm", className)}>{children}</code>;

const healthOf = (health: Storage["store"]["health"]): { readonly tone: "green" | "red"; readonly label: string; readonly reason: string | null } => {
  switch (health.status) {
    case "ok":
      return { tone: "green", label: t("storage.store.healthy"), reason: null };
    case "degraded":
      return { tone: "red", label: t("storage.store.degraded"), reason: health.reason };
    case "down":
      return { tone: "red", label: t("storage.store.unreachable"), reason: health.reason };
    default:
      return health satisfies never;
  }
};

/** Blob store: where files live, how much is there, and how to move to S3. No controls: it's a setting. */
export const BlobStoreSection = ({ storage }: { readonly storage: Storage | undefined }) => {
  const s3 = storage?.store.name === "s3";
  const health = storage === undefined ? null : healthOf(storage.store.health);
  const value = (node: (data: Storage) => ReactNode) => (storage === undefined ? <Skeleton className="w-[100px]" /> : node(storage));
  const [before = "", middle = "", after = ""] = t("storage.store.help", { store: "\u0000", s3: "\u0000" }).split("\u0000");
  return (
    <Section title={t("storage.store.title")} note={t("storage.store.note")}>
      <ul className="rows">
        <KeyRow label={t("storage.store.inUse")} end={health === null ? undefined : <Status tone={health.tone}>{health.label}</Status>}>
          {value((data) => (data.store.name === "s3" ? t("storage.store.s3") : t("storage.store.postgres")))}
        </KeyRow>
        <KeyRow label={t("storage.store.blobs")}>{value((data) => <Mono className="text-ui">{formatCount(data.blobCount)}</Mono>)}</KeyRow>
        <KeyRow label={t("storage.store.totalSize")}>{value((data) => <Mono className="text-ui">{formatBytes(data.totalBytes)}</Mono>)}</KeyRow>
        <KeyRow label={t("storage.store.cap")}>
          {value((data) => (
            <>
              <Mono className="text-ui">{formatBytes(data.capBytes)}</Mono>
              <Mono className="text-xs text-faint">OSTRA_BLOB_MAX_MIB</Mono>
            </>
          ))}
        </KeyRow>
        <KeyRow label={t("storage.store.s3Store")}>
          {value((data) => (data.store.s3Configured ? t("storage.store.s3InUse") : <span className="text-muted">{t("storage.store.s3NotConfigured")}</span>))}
        </KeyRow>
      </ul>
      {(health?.reason ?? null) === null ? null : (
        <p role="alert" className="mt-2.5 flex items-start gap-2 text-sm text-red">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
          {health?.reason}
        </p>
      )}
      <p className="mt-2.5 max-w-[740px] text-sm text-faint">
        {s3 ? (
          t("storage.store.helpS3")
        ) : (
          <>
            {before}
            <Mono className="text-xs">OSTRA_BLOB_STORE=s3</Mono>
            {middle}
            <Mono className="text-xs">OSTRA_S3_</Mono>
            {after}
          </>
        )}{" "}
        <a href={REFERENCE_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 whitespace-nowrap text-teal hover:underline">
          {t("storage.store.reference")}
          <ArrowUpRightIcon aria-hidden className="size-3 stroke-[1.75]" />
        </a>
      </p>
    </Section>
  );
};

export type RetentionSectionProps = {
  readonly storage: Storage | undefined;
  readonly draft: RetentionDraft;
  readonly onDraft: (draft: RetentionDraft) => void;
  readonly saved: boolean;
};

/** Retention: keep while the task exists (the default), or delete after a number of days. */
export const RetentionSection = ({ storage, draft, onDraft, saved }: RetentionSectionProps) => {
  const invalid = draftDays(draft) === "invalid";
  const disabled = storage === undefined;
  const typed = draft.mode === "delete" ? draft.days : "";
  return (
    <section className="mt-8">
      <h2 className="text-body font-semibold">{t("storage.retention.title")}</h2>
      <p className="mb-2 text-body text-muted">{t("storage.retention.lede")}</p>
      <RadioGroup
        value={draft.mode}
        disabled={disabled}
        onValueChange={(mode) => {
          onDraft(mode === "keep" ? { mode: "keep" } : { mode: "delete", days: typed === "" ? "90" : typed });
        }}
        aria-label={t("storage.retention.title")}
      >
        <label className="flex min-h-9 items-center gap-2.5 text-body">
          <RadioGroupItem value="keep" className="size-4 border-faint data-[state=checked]:border-[5px] data-[state=checked]:bg-bg [&>span]:hidden" />
          {t("storage.retention.keep")}
          <span className="ml-1.5 text-faint">{t("storage.retention.default")}</span>
        </label>
        <div className="flex min-h-9 flex-wrap items-center gap-x-2.5 gap-y-1 text-body">
          <label className="flex items-center gap-2.5">
            <RadioGroupItem value="delete" className="size-4 border-faint data-[state=checked]:border-[5px] data-[state=checked]:bg-bg [&>span]:hidden" />
            {t("storage.retention.deleteAfter")}
          </label>
          <Input
            aria-label={t("storage.retention.daysLabel")}
            inputMode="numeric"
            className={cn("ml-2 h-[30px] w-[72px] font-mono text-ui", invalid && "border-red")}
            aria-invalid={invalid}
            disabled={disabled || draft.mode !== "delete"}
            value={typed}
            onChange={(e) => {
              onDraft({ mode: "delete", days: e.target.value.replace(/[^\d]/g, "").slice(0, 4) });
            }}
          />
          <span className="ml-1.5">{t("storage.retention.daysAfter")}</span>
        </div>
      </RadioGroup>
      {invalid ? <p className="ml-[26px] text-xs text-red">{t("storage.retention.invalid")}</p> : null}
      {storage?.retention.source === "env" && draft.mode === draftOf(storage.retention.days).mode ? (
        <p className="mt-1 text-xs text-faint">{t("storage.retention.fromEnv")}</p>
      ) : null}
      {draft.mode === "delete" ? (
        <div data-testid="retention-deletes" className="ml-[19px] mt-2.5 border-l-2 border-line-2 pl-[18px] text-sm leading-5 text-muted">
          {deletionLines(draft.days).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}
      <p className="mt-3.5 text-xs text-faint">{t("storage.retention.audit")}</p>
      {saved ? (
        <p role="status" className="mt-2 flex items-center gap-1.5 text-sm text-green">
          <CheckIcon aria-hidden className="size-[14px] stroke-[1.75]" />
          {t("storage.retention.saved")}
        </p>
      ) : null}
    </section>
  );
};

const PanelLabel = ({ children }: { readonly children: ReactNode }) => <h3 className="mb-1.5 text-xs font-medium text-faint">{children}</h3>;
const Sep = () => <div className="my-3.5 h-px bg-line" />;

const ago = (at: number, now: number): string => {
  const hours = Math.floor((now - at) / 3_600_000);
  if (hours < 1) return `${String(Math.max(1, Math.floor((now - at) / 60_000)))}m ago`;
  if (hours < 48) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
};

const day = (at: number): string => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(at);

/** The properties panel: the settings behind the page, the sweeps and the last change. */
export const StorageProperties = ({ storage, now }: { readonly storage: Storage | undefined; readonly now: number }) => {
  const value = (node: (data: Storage) => ReactNode) => (storage === undefined ? <Skeleton className="w-[80px]" /> : node(storage));
  const row = (label: string, children: ReactNode, mono = true) => (
    <PropRow label={label} labelWidth={150} {...(mono ? { labelClassName: "font-mono text-xs" } : {})}>
      {children}
    </PropRow>
  );
  return (
    <div>
      <PanelLabel>{t("storage.panel.configuration")}</PanelLabel>
      {row("OSTRA_BLOB_STORE", value((data) => <Mono className="text-ui">{data.store.name}</Mono>))}
      {row("OSTRA_BLOB_MAX_MIB", value((data) => <Mono className="text-ui">{String(Math.round(data.capBytes / MiB))}</Mono>))}
      {row(
        "OSTRA_RETENTION_DAYS",
        value((data) =>
          data.retention.source === "env" ? (
            <Mono className="text-ui">{data.retention.days === null ? "keep" : String(data.retention.days)}</Mono>
          ) : data.retention.source === "default" ? (
            <Mono className="text-ui text-faint">{t("storage.panel.unset")}</Mono>
          ) : (
            <span className="text-faint" title={t("storage.retention.source.saved")}>
              –
            </span>
          ),
        ),
      )}
      <Sep />
      <PanelLabel>{t("storage.panel.sweeps")}</PanelLabel>
      {row(t("storage.panel.retention"), t("storage.panel.daily"), false)}
      {row(t("storage.panel.lastRan"), value((data) => (data.lastSweep === null ? <span className="text-faint">{t("storage.panel.never")}</span> : ago(data.lastSweep.at, now))), false)}
      {row(t("storage.panel.uploads"), t("storage.panel.uploadsValue"), false)}
      <Sep />
      <PanelLabel>{t("storage.panel.lastChange")}</PanelLabel>
      <p className="text-sm text-muted">
        {storage === undefined ? (
          <Skeleton className="w-[200px]" />
        ) : storage.retention.source === "saved" && storage.retention.savedAt !== null ? (
          storage.retention.days === null ? (
            t("storage.panel.turnedOff", { date: day(storage.retention.savedAt) })
          ) : (
            t("storage.panel.setTo", { days: storage.retention.days, date: day(storage.retention.savedAt) })
          )
        ) : storage.retention.source === "env" && storage.retention.days !== null ? (
          t("storage.panel.fromEnv", { days: storage.retention.days })
        ) : (
          t("storage.panel.neverChanged")
        )}
      </p>
      <p className="mt-1 text-xs text-faint">{storage === undefined ? null : t(`storage.retention.source.${storage.retention.source}`)}</p>
    </div>
  );
};

/** The confirmation before saving: what the next sweep deletes, or that nothing more is deleted. */
const ConfirmRetention = ({ days, draft, open, onOpenChange, onConfirm, pending, error }: { readonly days: number | null; readonly draft: RetentionDraft; readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly onConfirm: () => void; readonly pending: boolean; readonly error: string | null }) => {
  const words = confirmation(days);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line-2 bg-raise p-5 shadow-[0_8px_24px_rgba(0,0,0,0.45)] focus:outline-none">
          <Dialog.Title className="text-[16.5px] font-semibold text-text">{words.title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-1.5 space-y-1 text-ui text-muted">
              {words.turnsOff ? (
                <p>{t("storage.retention.confirmOffBody")}</p>
              ) : (
                <>
                  {deletionLines(draft.mode === "delete" ? draft.days : "").map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                  <p className="pt-1">{t("storage.retention.confirmOnAfter")}</p>
                </>
              )}
            </div>
          </Dialog.Description>
          {error === null ? null : (
            <p role="alert" className="mt-3 text-sm text-red">
              {error}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Cancel className={buttonVariants()}>{t("common.cancel")}</Dialog.Cancel>
            <Button variant="primary" disabled={pending} onClick={onConfirm}>
              {pending ? t("common.saving") : words.action}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

/** Organization › Storage (F-114, F-079; storage-settings.md). Instance admins only. */
export const StorageView = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const me = useQuery(trpc.me.get.queryOptions());
  const storage = useQuery(trpc.organization.storage.queryOptions());
  const [mounted] = useState(() => Date.now());
  const [edited, setEdited] = useState<RetentionDraft | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = useMutation(
    trpc.instance.saveRetention.mutationOptions({
      onSuccess: async () => {
        setConfirming(false);
        setEdited(null);
        setSaved(true);
        await queryClient.invalidateQueries({ queryKey: trpc.organization.storage.queryKey() });
      },
    }),
  );
  const inEffect = storage.data?.retention.days ?? null;
  const draft = edited ?? draftOf(inEffect);
  const days = draftDays(draft);
  const enabled = storage.data !== undefined && canSave(draft, inEffect);
  const now = storage.dataUpdatedAt === 0 ? mounted : storage.dataUpdatedAt;
  return (
    <PageFrame
      crumbs={[{ label: me.data?.organization?.name ?? t("shell.organization") }, { label: t("storage.title") }]}
      actions={
        <Button variant="primary" disabled={!enabled} onClick={() => { save.reset(); setConfirming(true); }}>
          {t("storage.save")}
        </Button>
      }
      properties={<StorageProperties storage={storage.data} now={now} />}
    >
      <PageHeading title={t("storage.title")} lede={t("storage.lede")} />
      {storage.isError ? (
        <p role="alert" className="mt-6 flex items-start gap-2 text-ui text-red">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
          {errorText(storage.error)}
        </p>
      ) : (
        <div className="max-w-[760px]">
          <BlobStoreSection storage={storage.data} />
          <RetentionSection
            storage={storage.data}
            draft={draft}
            saved={saved && edited === null}
            onDraft={(next) => {
              setSaved(false);
              setEdited(next);
            }}
          />
        </div>
      )}
      {days === "invalid" ? null : (
        <ConfirmRetention
          days={days}
          draft={draft}
          open={confirming}
          onOpenChange={setConfirming}
          pending={save.isPending}
          error={errorText(save.error)}
          onConfirm={() => { save.mutate({ days }); }}
        />
      )}
    </PageFrame>
  );
};
