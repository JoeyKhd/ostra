"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { appPathSchema, runnerLimits } from "@ostra/protocol";
import type { ProjectId, ScreenshotWidth } from "@ostra/protocol";

import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

// The App tab's first panel group (environment-app-processes.md, "The properties panel"):
// "Screenshots after each turn" (F-121), its routes and widths. Each control saves at once, as the
// Services and checks tab's do. Off and disabled with no primary process: none are taken then.

/** A panel group: the 12px `--faint` label, with a control at its right. */
export const AppGroup = ({ title, end, children, testId }: { readonly title: string; readonly end?: ReactNode; readonly children: ReactNode; readonly testId?: string }) => (
  <div className="mb-3.5 border-b border-line pb-3.5 last:border-b-0" data-testid={testId}>
    <div className="mb-1.5 flex min-h-[26px] items-center">
      <h3 className="text-xs font-medium text-faint">{title}</h3>
      {end === undefined ? null : <div className="ml-auto flex items-center">{end}</div>}
    </div>
    {children}
  </div>
);

/** One row of a group: the 96px key, then its value. */
export const AppRow = ({ label, children, align = "center" }: { readonly label: string; readonly children: ReactNode; readonly align?: "center" | "start" }) => (
  <div className={align === "start" ? "grid min-h-7 grid-cols-[96px_minmax(0,1fr)] items-start gap-2 py-0.5 text-ui" : "grid min-h-7 grid-cols-[96px_minmax(0,1fr)] items-center gap-2 text-ui"}>
    <span className={align === "start" ? "pt-1 text-muted" : "text-muted"}>{label}</span>
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-text">{children}</div>
  </div>
);

const WIDTHS: readonly { readonly width: ScreenshotWidth; readonly key: "desktop" | "phone"; readonly size: string }[] = [
  { width: "desktop", key: "desktop", size: "1440 × 900" },
  { width: "phone", key: "phone", size: "390 × 844" },
];

export const ScreenshotSettings = ({ projectId, canEdit, noBrowser }: { readonly projectId: ProjectId; readonly canEdit: boolean; readonly noBrowser: boolean }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(trpc.environments.screenshots.get.queryOptions({ projectId }));
  const save = useMutation(
    trpc.environments.screenshots.save.mutationOptions({
      onSuccess: (saved) => { queryClient.setQueryData(trpc.environments.screenshots.get.queryKey({ projectId }), saved); },
    }),
  );
  const [adding, setAdding] = useState<string | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const data = settings.data;
  if (data === undefined) {
    return (
      <AppGroup title={t("environment.app.shots.title")}>
        {[0, 1, 2].map((index) => <Skeleton key={index} className="my-2 h-4 w-40" />)}
      </AppGroup>
    );
  }
  const noPrimary = data.primary === null;
  const editable = canEdit && !save.isPending;
  const put = (change: Partial<{ afterTurn: boolean; routes: string[]; widths: ScreenshotWidth[] }>) => {
    save.mutate({ projectId, afterTurn: data.afterTurn, routes: data.routes, widths: data.widths, ...change });
  };
  const addRoute = () => {
    const route = (adding ?? "").trim();
    if (route === "") {
      setAdding(null);
      return;
    }
    if (!appPathSchema.safeParse(route).success) {
      setRouteError(t("environment.app.refuse.readyPath"));
      return;
    }
    if (data.routes.includes(route)) {
      setRouteError(t("environment.app.shots.routeTwice"));
      return;
    }
    setRouteError(null);
    setAdding(null);
    put({ routes: [...data.routes, route] });
  };
  return (
    <AppGroup
      title={t("environment.app.shots.title")}
      testId="screenshot-settings"
      end={
        <Switch
          aria-label={t("environment.app.shots.title")}
          checked={data.afterTurn && !noPrimary}
          disabled={!editable || noPrimary}
          onCheckedChange={(afterTurn) => { put({ afterTurn }); }}
        />
      }
    >
      <p className="mb-2 text-[12.5px] text-faint" data-testid="screenshots-note">
        {noPrimary
          ? t("environment.app.shots.choosePrimary")
          : noBrowser
            ? t("environment.app.shots.waitingForBrowser")
            : <>{t("environment.app.shots.noteBefore")} <span className="font-mono">{data.primary}</span> {t("environment.app.shots.noteAfter")}</>}
      </p>
      <AppRow label={t("environment.app.shots.routes")} align="start">
        {data.routes.map((route) => (
          <span key={route} className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-line-2 pl-2 pr-1 font-mono text-[12.5px] text-text" data-route={route}>
            {route}
            {editable && data.routes.length > 1 ? (
              <button type="button" aria-label={t("environment.app.shots.removeRoute", { route })} className="grid size-4 place-items-center rounded-sm text-faint hover:text-text" onClick={() => { put({ routes: data.routes.filter((one) => one !== route) }); }}>
                <XIcon aria-hidden className="size-[11px]" />
              </button>
            ) : null}
          </span>
        ))}
        {!canEdit || data.routes.length >= runnerLimits.screenshotRoutesMax ? null : adding === null ? (
          <button type="button" className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-dashed border-control-line px-2 text-[12.5px] text-muted hover:text-text" onClick={() => { setAdding("/"); }}>
            <PlusIcon aria-hidden className="size-[11px]" />
            {t("environment.app.shots.route")}
          </button>
        ) : (
          <input
            autoFocus
            aria-label={t("environment.app.shots.newRoute")}
            className="h-6 w-28 rounded-[5px] border border-control-line bg-surface px-2 font-mono text-[12.5px] text-text focus-visible:border-faint"
            value={adding}
            onChange={(event) => { setAdding(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addRoute();
              } else if (event.key === "Escape") {
                event.stopPropagation();
                setAdding(null);
                setRouteError(null);
              }
            }}
            onBlur={addRoute}
          />
        )}
      </AppRow>
      {routeError === null ? null : <p role="alert" className="mb-1 ml-[104px] text-[12.5px] text-red">{routeError}</p>}
      <AppRow label={t("environment.app.shots.widths")} align="start">
        <span className="flex flex-col gap-1.5 pt-1">
          {WIDTHS.map(({ width, key, size }) => {
            const checked = data.widths.includes(width);
            // Desktop is always taken (ADR 0068: "desktop, and phone if chosen").
            const locked = width === "desktop";
            return (
              <label key={width} className="flex items-center gap-2 text-ui text-text">
                <Checkbox
                  tone="teal"
                  className={locked ? "size-[15px] disabled:opacity-100" : "size-[15px]"}
                  checked={checked || locked}
                  disabled={!editable || locked}
                  onCheckedChange={(value) => { put({ widths: value === true ? ["desktop", "phone"] : ["desktop"] }); }}
                />
                {t(`environment.app.shots.${key}`)}
                <span className="font-mono text-[12.5px] text-faint">{size}</span>
              </label>
            );
          })}
        </span>
      </AppRow>
      <p className="mt-2 text-[12.5px] text-faint">{t("environment.app.shots.help")}</p>
      {save.error === null ? null : <p role="alert" className="mt-1.5 text-[12.5px] text-red">{errorText(save.error)}</p>}
    </AppGroup>
  );
};
