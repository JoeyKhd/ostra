"use client";

import { LockIcon, PlugIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Chip } from "@/components/ui/status";
import { Switch } from "@/components/ui/switch";
import { t } from "@/lib/messages";

import { EditorSection } from "./editor-section";
import { commandLine, nextKey, serverProblem } from "./editor-draft";
import type { ServerDraft } from "./editor-draft";
import { GroupLabel } from "./profile-library";
import { AddButton, RemoveButton } from "./rules-section";
import type { SectionLibrary } from "./skills-section";

// The editor's MCP servers section and its Sheet (agent-profile.md, "MCP servers"). An HTTP
// server's header values are write-only: they go to the secret store with the save, and come back
// only as "set".

type Http = Extract<ServerDraft, { transport: "http" }>;
type Stdio = Extract<ServerDraft, { transport: "stdio" }>;

const HeadersChips = ({ server }: { readonly server: Http }) => {
  const [first, ...rest] = server.headers;
  if (first === undefined) return null;
  return (
    <span className="hidden shrink-0 items-center gap-2 md:flex">
      <span className="font-mono text-ui text-muted">{first.name}</span>
      {first.stored || first.value !== "" ? <Chip className="h-5 px-1.5 text-xs"><LockIcon aria-hidden /> {t("agentProfiles.editor.set")}</Chip> : null}
      {rest.length === 0 ? null : <span className="text-faint">+{rest.length}</span>}
    </span>
  );
};

const ServerSheet = ({ server, others, onDone, onClose }: {
  readonly server: ServerDraft;
  readonly others: readonly ServerDraft[];
  readonly onDone: (server: ServerDraft) => void;
  readonly onClose: () => void;
}) => {
  const id = useId();
  const [draft, setDraft] = useState<ServerDraft>(server);
  const [tried, setTried] = useState(false);
  const problem = serverProblem(draft, others);
  const errorOf = (field: "name" | "url" | "command"): string | null => (tried && problem?.field === field ? t(problem.key) : null);
  const title = draft.transport === "http" ? t("agentProfiles.server.titleHttp") : t("agentProfiles.server.titleStdio");
  const help = (field: "name" | "url" | "command", text: string | null) => {
    const error = errorOf(field);
    return error === null ? (text === null ? null : <p className="mt-1.5 text-sm text-faint">{text}</p>) : <p role="alert" className="mt-1.5 text-sm text-red">{error}</p>;
  };
  const setHttp = (next: Partial<Omit<Http, "transport" | "key">>): void => { if (draft.transport === "http") setDraft({ ...draft, ...next }); };
  const setStdio = (next: Partial<Omit<Stdio, "transport" | "key">>): void => { if (draft.transport === "stdio") setDraft({ ...draft, ...next }); };

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent title={title} className="w-full sm:w-[420px]">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-5 pt-5">
          <h2 className="mb-4 text-[16px] font-semibold">{title}</h2>
          <div className="mb-3.5">
            <Label htmlFor={`${id}-name`}>{t("agentProfiles.server.name")}</Label>
            <Input id={`${id}-name`} value={draft.name} className="font-mono" spellCheck={false} aria-invalid={errorOf("name") !== null}
              onChange={(event) => { setDraft({ ...draft, name: event.target.value }); }} />
            {help("name", null)}
          </div>
          {draft.transport === "http" ? (
            <>
              <div className="mb-3.5">
                <Label htmlFor={`${id}-url`}>{t("agentProfiles.server.url")}</Label>
                <Input id={`${id}-url`} value={draft.url} className="font-mono" spellCheck={false} placeholder="https://" aria-invalid={errorOf("url") !== null}
                  onChange={(event) => { setHttp({ url: event.target.value }); }} />
                {help("url", null)}
              </div>
              <div className="mb-3.5">
                <div className="mb-1.5 text-sm font-medium text-muted">{t("agentProfiles.server.headers")}</div>
                {draft.headers.map((header, index) => (
                  <div key={header.key} className="mb-1.5 flex items-center gap-1.5">
                    <Input value={header.name} aria-label={t("agentProfiles.server.headerName")} className="h-8 w-[140px] font-mono text-ui" spellCheck={false}
                      onChange={(event) => { setHttp({ headers: draft.headers.map((entry, i) => (i === index ? { ...entry, name: event.target.value } : entry)) }); }} />
                    <Input type="password" value={header.value} autoComplete="off" aria-label={t("agentProfiles.server.headerValue")}
                      placeholder={header.stored ? t("agentProfiles.server.headerStored") : t("agentProfiles.server.headerValue")}
                      className="h-8 min-w-0 flex-1 text-ui"
                      onChange={(event) => { setHttp({ headers: draft.headers.map((entry, i) => (i === index ? { ...entry, value: event.target.value } : entry)) }); }} />
                    <RemoveButton label={t("agentProfiles.server.removeHeader")} onClick={() => { setHttp({ headers: draft.headers.filter((_, i) => i !== index) }); }} />
                  </div>
                ))}
                <AddButton onClick={() => { setHttp({ headers: [...draft.headers, { key: nextKey("h"), name: "", value: "", stored: false }] }); }}>{t("agentProfiles.server.addHeader")}</AddButton>
                <p className="mt-1.5 text-sm text-faint">{t("agentProfiles.server.headersHelp")}</p>
              </div>
            </>
          ) : (
            <>
              <div className="mb-3.5">
                <Label htmlFor={`${id}-command`}>{t("agentProfiles.server.command")}</Label>
                <Input id={`${id}-command`} value={draft.command} className="font-mono" spellCheck={false} aria-invalid={errorOf("command") !== null}
                  onChange={(event) => { setStdio({ command: event.target.value }); }} />
                {help("command", t("agentProfiles.server.commandHelp"))}
              </div>
              <div className="mb-3.5">
                <Label htmlFor={`${id}-args`}>{t("agentProfiles.server.args")}</Label>
                <Textarea id={`${id}-args`} value={draft.args} rows={3} className="min-h-[72px] font-mono text-ui" spellCheck={false}
                  onChange={(event) => { setStdio({ args: event.target.value }); }} />
                <p className="mt-1.5 text-sm text-faint">{t("agentProfiles.server.argsHelp")}</p>
              </div>
              <div className="mb-3.5">
                <div className="mb-1.5 text-sm font-medium text-muted">{t("agentProfiles.server.env")}</div>
                {draft.env.map((entry, index) => (
                  <div key={entry.key} className="mb-1.5 flex items-center gap-1.5">
                    <Input value={entry.name} aria-label={t("agentProfiles.server.envName")} className="h-8 w-[140px] font-mono text-ui" spellCheck={false}
                      onChange={(event) => { setStdio({ env: draft.env.map((row, i) => (i === index ? { ...row, name: event.target.value } : row)) }); }} />
                    <Input value={entry.value} aria-label={t("agentProfiles.server.envValue")} className="h-8 min-w-0 flex-1 font-mono text-ui" spellCheck={false}
                      onChange={(event) => { setStdio({ env: draft.env.map((row, i) => (i === index ? { ...row, value: event.target.value } : row)) }); }} />
                    <RemoveButton label={t("agentProfiles.server.removeHeader")} onClick={() => { setStdio({ env: draft.env.filter((_, i) => i !== index) }); }} />
                  </div>
                ))}
                <AddButton onClick={() => { setStdio({ env: [...draft.env, { key: nextKey("e"), name: "", value: "" }] }); }}>{t("agentProfiles.server.addEnv")}</AddButton>
                <p className="mt-1.5 text-sm text-faint">{t("agentProfiles.server.envHelp")}</p>
              </div>
            </>
          )}
          <div className="mb-5">
            <div className="flex items-center justify-between gap-3">
              <span id={`${id}-ro`} className="text-sm font-medium text-muted">{t("agentProfiles.server.readOnly")}</span>
              <Switch aria-labelledby={`${id}-ro`} checked={draft.readOnly} onCheckedChange={(readOnly) => { setDraft({ ...draft, readOnly }); }} />
            </div>
            <p className="mt-1.5 text-sm text-faint">{t("agentProfiles.server.readOnlyHelp")}</p>
          </div>
          <div className="mt-auto flex justify-end">
            <Button variant="primary" onClick={() => {
              setTried(true);
              if (problem === null) onDone(draft);
            }}>{t("agentProfiles.server.done")}</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};

export const McpSection = ({ servers, readOnly, onChange, library }: {
  readonly servers: readonly ServerDraft[];
  readonly readOnly: boolean;
  readonly onChange: (servers: readonly ServerDraft[]) => void;
  readonly library?: SectionLibrary;
}) => {
  const [editing, setEditing] = useState<ServerDraft | null>(null);
  return (
    <EditorSection title={t("agentProfiles.editor.mcp")} count={library?.count ?? servers.length} note={t("agentProfiles.editor.mcpNote")}>
      {library?.hasRows === true && servers.length > 0 ? <GroupLabel label={t("agentProfiles.library.itsOwn")} count={servers.length} /> : null}
      {servers.length === 0 && library?.hasRows === true ? null : servers.length === 0 ? (
        <p className="flex h-10 items-center border-y border-line text-ui text-faint">{t("agentProfiles.editor.noMcp")}</p>
      ) : (
        <ul className="border-t border-line" data-testid="mcp-servers">
          {servers.map((server) => {
            const where = server.transport === "http" ? server.url : commandLine(server);
            return (
              <li key={server.key} className="flex h-10 items-center gap-3 border-b border-line" data-server={server.name}>
                <PlugIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-faint" />
                <span className="w-[120px] shrink-0 truncate font-mono text-body sm:w-[150px]">{server.name}</span>
                <Chip className="h-5 shrink-0 px-1.5 text-xs">{server.transport === "http" ? t("agentProfiles.editor.http") : t("agentProfiles.editor.stdio")}</Chip>
                <span className="hidden min-w-0 flex-1 truncate font-mono text-ui text-faint sm:block" title={where}>{where}</span>
                {server.transport === "http" ? <HeadersChips server={server} /> : null}
                {server.readOnly ? <Chip className="h-5 shrink-0 px-1.5 text-xs">{t("agentProfiles.editor.readOnly")}</Chip> : null}
                {readOnly ? null : (
                  <>
                    <Button variant="link" className="ml-auto shrink-0 text-ui font-normal sm:ml-0" onClick={() => { setEditing(server); }}>{t("agentProfiles.editor.edit")}</Button>
                    <RemoveButton label={t("agentProfiles.editor.remove", { name: server.name })} onClick={() => { onChange(servers.filter((entry) => entry.key !== server.key)); }} />
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {library?.groups}
      {readOnly ? null : (
        <div className="mt-2 flex flex-wrap gap-3">
          <AddButton onClick={() => { setEditing({ key: nextKey("s"), transport: "http", name: "", url: "", headers: [], readOnly: false }); }}>{t("agentProfiles.editor.addHttp")}</AddButton>
          <AddButton onClick={() => { setEditing({ key: nextKey("s"), transport: "stdio", name: "", command: "", args: "", env: [], readOnly: false }); }}>{t("agentProfiles.editor.addStdio")}</AddButton>
          {library?.picker}
        </div>
      )}
      {library?.refusal}
      {editing === null ? null : (
        <ServerSheet
          server={editing}
          others={servers}
          onClose={() => { setEditing(null); }}
          onDone={(server) => {
            onChange(servers.some((entry) => entry.key === server.key) ? servers.map((entry) => (entry.key === server.key ? server : entry)) : [...servers, server]);
            setEditing(null);
          }}
        />
      )}
    </EditorSection>
  );
};
