"use client";

import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon, SearchIcon, ShieldIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { CopyLink } from "@/components/runners/copy-link";
import { PageFrame, PageHeading, PropGroup, PropRow, Section } from "@/components/shell/page-frame";
import { AlertDialog, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { lastActiveText, shortDate } from "@/components/members/member-words";

type Account = RouterOutputs["instance"]["accounts"]["search"]["accounts"][number];
type Admin = RouterOutputs["instance"]["admins"][number];
type Cursor = NonNullable<RouterOutputs["instance"]["accounts"]["search"]["next"]>;

const grid = "grid items-center gap-x-3 grid-cols-[minmax(180px,1.4fr)_90px_minmax(170px,1.3fr)_minmax(120px,1fr)_100px]";

/** `Acme Corp`, `Acme Corp, Second`, `Acme Corp, +2`; none: `none`. */
const organizationsText = (names: readonly string[]): string => {
  if (names.length <= 2) return names.join(", ");
  return `${names[0] ?? ""}, +${String(names.length - 1)}`;
};

/**
 * The middle of a long link gives way to `…`, so its start and its end both show at any width: the
 * head truncates with an ellipsis, and the tail, its last characters, always shows.
 */
const tailLength = 6;
const middleHead = (text: string): string => text.slice(0, -tailLength);
const middleTail = (text: string): string => text.slice(-tailLength);

type ResetLink = { readonly userId: string; readonly link: string; readonly count: number };

const AccountPanel = ({
  account,
  selfUserId,
  emailOn,
  hours,
  admin,
  reset,
  onReset,
  onGrant,
  onRevoke,
}: {
  readonly account: Account;
  readonly selfUserId: string | null;
  readonly emailOn: boolean;
  readonly hours: number;
  readonly admin: Admin | undefined;
  readonly reset: ResetLink | null;
  readonly onReset: (link: string) => void;
  readonly onGrant: () => void;
  readonly onRevoke: () => void;
}) => {
  const trpc = useTRPC();
  // On the mutation, not on `mutate`: the link still lands if the panel re-renders while it's made.
  const create = useMutation(trpc.accounts.createResetLink.mutationOptions({ onSuccess: (result) => { onReset(result.link); } }));
  const own = account.userId === selfUserId;
  const first = account.name.split(/\s+/)[0] ?? account.name;
  const mailLine = !emailOn ? t("instance.accounts.mailOff", { name: first }) : account.emailVerified ? t("instance.accounts.mailOn", { name: first }) : t("instance.accounts.mailUnverified", { name: first });
  return (
    <div>
      <PropGroup title={account.name}>
        <PropRow label={t("instance.accounts.panelUsername")} labelWidth={130}><span className="font-mono">{account.username}</span></PropRow>
        <PropRow label={t("instance.accounts.panelAddress")} labelWidth={130}><span className="truncate">{account.email}</span></PropRow>
        <PropRow label={t("instance.accounts.panelVerified")} labelWidth={130}>{account.emailVerified ? t("common.yes") : <span className="text-muted">{t("instance.accounts.panelNotYet")}</span>}</PropRow>
        <PropRow label={t("instance.accounts.panelOrganizations")} labelWidth={130}>
          {account.organizations.length === 0 ? <span className="text-faint">{t("instance.accounts.none")}</span> : <span className="flex flex-col">{account.organizations.map((name) => <span key={name}>{name}</span>)}</span>}
        </PropRow>
        <PropRow label={t("instance.accounts.panelCreated")} labelWidth={130}>{shortDate(account.createdAt)}</PropRow>
        <PropRow label={t("instance.accounts.panelLastSignIn")} labelWidth={130}>
          {account.lastSignInAt === null ? <span className="text-faint">{t("instance.accounts.never")}</span> : lastActiveText(account.lastSignInAt, Date.now())}
        </PropRow>
      </PropGroup>
      <div className="mb-3.5 border-b border-line pb-3.5">
        <h3 className="mb-2 text-xs font-medium text-faint">{t("instance.accounts.resetGroup")}</h3>
        {own ? (
          <p className="text-sm text-muted">
            {t("instance.accounts.own")} <Link href="/account" className="text-teal hover:underline">{t("instance.accounts.ownLink")}</Link>
          </p>
        ) : (
          <>
            {reset === null ? null : (
              <>
                <div className="flex min-h-9 items-center gap-3 rounded-lg border border-line bg-surface px-3 py-1.5">
                  <code data-testid="reset-link" aria-label={reset.link} className="flex min-w-0 flex-1 font-mono text-[13px] text-text">
                    <span className="min-w-0 truncate">{middleHead(reset.link)}</span>
                    <span className="shrink-0">{middleTail(reset.link)}</span>
                  </code>
                  <CopyLink text={reset.link} />
                </div>
                <p className="mt-1.5 text-xs text-muted">{t("instance.accounts.resetShown", { hours })}</p>
              </>
            )}
            <Button
              size="sm"
              className={cn(reset === null ? "" : "mt-3")}
              disabled={create.isPending}
              onClick={() => {
                create.mutate({ userId: account.userId });
              }}
            >
              <KeyRoundIcon aria-hidden className="stroke-[1.75]" />
              {reset === null ? t("instance.accounts.createReset") : t("instance.accounts.createAnother")}
            </Button>
            <p className="mt-1.5 text-xs text-faint">{reset === null ? t("instance.accounts.resetHint", { hours, name: first }) : t("instance.accounts.resetEarlier")}</p>
            {create.isError ? <p role="alert" className="mt-1.5 text-sm text-red">{errorText(create.error)}</p> : null}
          </>
        )}
        <p className="mt-1.5 text-xs text-faint">{mailLine}</p>
      </div>
      <div>
        <h3 className="mb-2 text-xs font-medium text-faint">{t("instance.accounts.adminGroup")}</h3>
        {admin === undefined ? (
          <>
            <p className="mb-2 text-ui text-muted">{t("instance.accounts.notAdmin", { name: first })}</p>
            <Button size="sm" onClick={onGrant}><ShieldIcon aria-hidden className="stroke-[1.75]" />{t("instance.accounts.makeAdmin")}</Button>
          </>
        ) : (
          <p className="flex items-center gap-3 text-ui text-muted">
            {t("instance.accounts.adminSince", { date: shortDate(admin.since) })}
            <Button variant="ghost" size="sm" onClick={onRevoke}>{t("instance.accounts.remove")}</Button>
          </p>
        )}
      </div>
    </div>
  );
};

/**
 * Instance › Accounts (F-003, F-002; instance-settings.md, page 2): every account on the install,
 * found by username or address; a reset link shown once; and who the instance admins are.
 */
export const AccountsView = ({ emailOn, hours }: { readonly emailOn: boolean; readonly hours: number }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const me = useQuery(trpc.me.get.queryOptions());
  const [typed, setTyped] = useState(search.get("q") ?? "");
  const [query, setQuery] = useState(typed);
  const [picked, setPicked] = useState<string | null>(null);
  const [reset, setReset] = useState<ResetLink | null>(null);
  const [confirm, setConfirm] = useState<{ readonly kind: "grant" | "revoke"; readonly userId: Account["userId"]; readonly name: string } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(typed);
      const next = new URLSearchParams(search.toString());
      if (typed === "") next.delete("q");
      else next.set("q", typed);
      const rest = next.toString();
      router.replace(rest === "" ? pathname : `${pathname}?${rest}`, { scroll: false });
    }, 200);
    return () => { clearTimeout(timer); };
    // The URL follows the field; the field doesn't follow the URL back.
  }, [typed]);

  /** Keyset pages of 50: the first, then each `Show more`. A new query starts over. */
  const [cursors, setCursors] = useState<readonly (Cursor | null)[]>([null]);
  useEffect(() => { setCursors([null]); }, [query]);
  // The list holds while a new query loads, so the selected account and its panel (a reset link being
  // made) stay put.
  const pages = useQueries({
    queries: cursors.map((cursor) => ({ ...trpc.instance.accounts.search.queryOptions({ query, ...(cursor === null ? {} : { cursor }) }), placeholderData: keepPreviousData })),
  });
  const first = pages[0];
  const last = pages[pages.length - 1];
  const nextCursor = last?.data?.next ?? null;
  const admins = useQuery(trpc.instance.admins.queryOptions());
  const refresh = async () => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: trpc.instance.pathKey() }), queryClient.invalidateQueries({ queryKey: trpc.me.get.queryKey() })]);
  };
  const grant = useMutation(trpc.instance.grantAdmin.mutationOptions({ onSettled: () => refresh() }));
  const revoke = useMutation(
    trpc.instance.revokeAdmin.mutationOptions({
      onSuccess: (_result, input) => {
        if (input.userId === me.data?.userId) router.replace("/");
      },
      onSettled: () => refresh(),
    }),
  );

  const list = pages.flatMap((page) => page.data?.accounts ?? []);
  const adminList = admins.data ?? [];
  const selfUserId = me.data?.userId ?? null;
  const selected = list.find((account) => account.userId === picked);
  const lastAdmin = adminList.length <= 1;

  return (
    <AlertDialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
      <PageFrame
        crumbs={[{ label: t("shell.instance") }, { label: t("instance.accounts.title") }]}
        properties={
          selected === undefined ? (
            <p className="text-ui text-muted">{t("instance.accounts.pick")}</p>
          ) : (
            <AccountPanel
              key={selected.userId}
              account={selected}
              selfUserId={selfUserId}
              emailOn={emailOn}
              hours={hours}
              admin={adminList.find((admin) => admin.userId === selected.userId)}
              reset={reset?.userId === selected.userId ? reset : null}
              onReset={(link) => { setReset({ userId: selected.userId, link, count: (reset?.count ?? 0) + 1 }); }}
              onGrant={() => { setConfirm({ kind: "grant", userId: selected.userId, name: selected.name }); }}
              onRevoke={() => { setConfirm({ kind: "revoke", userId: selected.userId, name: selected.name }); }}
            />
          )
        }
      >
        <PageHeading title={t("instance.accounts.title")} lede={t("instance.accounts.lede")} />
        <div className="relative mt-5 w-full sm:w-[320px]">
          <SearchIcon aria-hidden className="absolute left-2.5 top-1/2 size-[14px] -translate-y-1/2 stroke-[1.75] text-faint" />
          <Input
            type="search"
            aria-label={t("instance.accounts.search")}
            placeholder={t("instance.accounts.search")}
            value={typed}
            className="pl-8"
            onChange={(event) => { setTyped(event.target.value); }}
            onKeyDown={(event) => { if (event.key === "Escape") setTyped(""); }}
          />
        </div>

        <Section title={t("instance.accounts.section")} {...(first?.data === undefined ? {} : { count: list.length })}>
          {first?.isError === true ? (
            <p role="alert" className="text-sm text-red">{errorText(first.error)}</p>
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[720px]">
                <div className={cn(grid, "h-[30px] border-b border-line text-[12.5px] font-medium text-faint")}>
                  <span className="pl-2">{t("instance.accounts.colName")}</span>
                  <span>{t("instance.accounts.colUsername")}</span>
                  <span>{t("instance.accounts.colAddress")}</span>
                  <span>{t("instance.accounts.colOrganizations")}</span>
                  <span>{t("instance.accounts.colLastSignIn")}</span>
                </div>
                {first?.data === undefined ? (
                  <div aria-busy>{[0, 1, 2].map((i) => <div key={i} className="flex h-[38px] items-center border-b border-line"><Skeleton className="w-[260px]" /></div>)}</div>
                ) : list.length === 0 ? (
                  <p className="flex h-[38px] items-center border-b border-line text-ui text-muted">{t("instance.accounts.noMatch", { query })}</p>
                ) : (
                  <ul aria-label={t("instance.accounts.section")}>
                    {list.map((account) => (
                      <li key={account.userId}>
                        <button
                          type="button"
                          aria-pressed={selected?.userId === account.userId}
                          onClick={() => { setPicked(account.userId); }}
                          className={cn(grid, "h-[38px] w-full border-b border-line text-left text-ui hover:bg-hover", selected?.userId === account.userId && "bg-sel hover:bg-sel")}
                        >
                          <span className="flex min-w-0 items-center gap-2 pl-2">
                            <span className="truncate text-text">{account.name}</span>
                            {account.instanceAdminSince === null ? null : <Chip>{t("instance.accounts.instanceAdmin")}</Chip>}
                          </span>
                          <span className="truncate font-mono text-[13px] text-muted">{account.username}</span>
                          <span className="truncate text-muted">
                            {account.email}
                            {account.emailVerified ? null : <span className="text-faint">{t("instance.accounts.notVerified")}</span>}
                          </span>
                          <span className="truncate text-muted">{account.organizations.length === 0 ? <span className="text-faint">{t("instance.accounts.none")}</span> : organizationsText(account.organizations)}</span>
                          <span className={cn("truncate", account.lastSignInAt === null ? "text-faint" : "text-muted")}>
                            {account.lastSignInAt === null ? t("instance.accounts.never") : lastActiveText(account.lastSignInAt, Date.now())}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
          {nextCursor === null ? null : (
            <Button variant="ghost" size="sm" className="mt-2" disabled={last?.isFetching === true} onClick={() => { setCursors([...cursors, nextCursor]); }}>
              {t("instance.accounts.showMore")}
            </Button>
          )}
        </Section>

        <Section title={t("instance.accounts.admins")} {...(admins.data === undefined ? {} : { count: adminList.length })} className="mt-8">
          {revoke.isError ? <p role="alert" className="mb-1 text-sm text-red">{errorText(revoke.error)}</p> : null}
          <ul aria-label={t("instance.accounts.admins")}>
            {adminList.map((admin) => {
              const self = admin.userId === selfUserId;
              return (
                <li key={admin.userId} data-testid="instance-admin-row" className="grid h-[38px] grid-cols-[minmax(0,1.4fr)_minmax(0,1.3fr)_minmax(0,1fr)_80px] items-center gap-x-3 border-b border-line text-ui">
                  <span className="truncate pl-2 text-text">{admin.name}{self ? <span className="text-faint">{t("instance.accounts.you")}</span> : null}</span>
                  <span className="truncate text-muted">{admin.email}</span>
                  <span className="truncate text-muted">{t("instance.accounts.since", { date: shortDate(admin.since) })}</span>
                  <span className="flex justify-end">
                    {self && lastAdmin ? null : (
                      <Button variant="ghost" size="sm" onClick={() => { setConfirm({ kind: "revoke", userId: admin.userId, name: admin.name }); }}>{t("instance.accounts.remove")}</Button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2.5 text-sm text-faint">{t("instance.accounts.adminsHelp")}</p>
        </Section>
      </PageFrame>

      {confirm === null ? null : confirm.kind === "grant" ? (
        <AlertDialogContent
          title={t("instance.accounts.grantTitle", { name: confirm.name })}
          body={t("instance.accounts.grantBody", { name: confirm.name.split(/\s+/)[0] ?? confirm.name })}
          cancel={t("common.cancel")}
          action={t("instance.accounts.makeAdmin")}
          onAction={() => { grant.mutate({ userId: confirm.userId }); }}
        />
      ) : (
        <AlertDialogContent
          title={t("instance.accounts.removeTitle", { name: confirm.name })}
          body={`${t("instance.accounts.removeBody", { name: confirm.name.split(/\s+/)[0] ?? confirm.name })}${confirm.userId === selfUserId ? ` ${t("instance.accounts.removeSelf")}` : ""}`}
          cancel={t("common.cancel")}
          action={t("instance.accounts.remove")}
          onAction={() => { revoke.mutate({ userId: confirm.userId }); }}
        />
      )}
    </AlertDialog>
  );
};
