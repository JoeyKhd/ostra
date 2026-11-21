"use client";

import { useState } from "react";

import { Tooltip } from "@/components/ui/tooltip";
import { t } from "@/lib/messages";

import { addressRows } from "./environment-app-words";
import { AppGroup } from "./screenshot-settings";

// The App tab's "In-box addresses" (environment-app-processes.md): what each process gets in the
// box, `OSTRA_APP_<NAME>_URL` and `OSTRA_SERVICE_<NAME>_URL` (ADR 0068), computed from the names and
// never stored. None is for a browser: the app keeps the primary's origin, its API behind the dev
// server's proxy. A service's is its `docker` address, with its `kubernetes` one in the tooltip.

/** The rows shown before "Show all". */
const SHOWN = 3;

export const InBoxAddresses = ({ processes, services }: {
  readonly processes: readonly { readonly name: string; readonly port: number; readonly primary: boolean }[];
  readonly services: readonly { readonly name: string; readonly port: number | null }[];
}) => {
  const [all, setAll] = useState(false);
  const rows = addressRows(processes, services);
  if (rows.length === 0) return null;
  const primary = processes.find((process) => process.primary)?.name ?? processes[0]?.name ?? "web";
  const shown = all ? rows : rows.slice(0, SHOWN);
  const hidden = rows.slice(SHOWN).filter((row) => row.kind === "service").length;
  return (
    <AppGroup title={t("environment.app.addresses.title")} testId="in-box-addresses">
      <p className="mb-2 text-[12.5px] text-faint">{t("environment.app.addresses.note", { name: primary })}</p>
      <ul className="space-y-1.5">
        {shown.map((row) => {
          const value = <span className="block truncate font-mono text-[12.5px] text-muted">{row.value}</span>;
          return (
            <li key={row.name} data-address={row.name}>
              <span className="block truncate font-mono text-[12.5px] text-text">{row.name}</span>
              {row.other === null ? value : <Tooltip content={t("environment.app.addresses.onKubernetes", { address: row.other })}><span className="block" tabIndex={0}>{value}</span></Tooltip>}
            </li>
          );
        })}
      </ul>
      {!all && rows.length > SHOWN ? (
        <p className="mt-1.5 text-[12.5px] text-faint">
          {hidden > 0 ? t("environment.app.addresses.more", { n: hidden }) : t("environment.app.addresses.moreRows", { n: rows.length - SHOWN })}{" · "}
          <button type="button" className="text-teal hover:underline" onClick={() => { setAll(true); }}>{t("environment.app.addresses.showAll")}</button>
        </p>
      ) : null}
    </AppGroup>
  );
};
