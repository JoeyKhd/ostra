"use client";

import { BookOpenIcon, FileIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { plural, t } from "@/lib/messages";

import { EditorSection } from "./editor-section";
import { pickedFileProblem, skillDescription, skillProblem, withFile } from "./editor-draft";
import type { SkillDraft, SkillFileDraft, SkillProblem } from "./editor-draft";
import { AddButton, RemoveButton } from "./rules-section";
import { uploadSkillFile } from "./skill-file-upload";

// The editor's Skills section and its Sheet (agent-profile.md, "Skills"): each skill's name, the
// description read from its SKILL.md, its files, and the Sheet that edits them. Saving still
// happens with "Save profile".

const sizeText = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : bytes >= 1024 ? `${String(Math.round(bytes / 1024))} KiB` : `${String(bytes)} B`;

const filesWord = (n: number): string =>
  n === 0 ? t("agentProfiles.editor.skillFiles") : plural(n, "agentProfiles.editor.skillFilesOne", "agentProfiles.editor.skillFilesMany");

const SkillSheet = ({ skill, others, onDone, onClose }: {
  readonly skill: SkillDraft;
  readonly others: readonly SkillDraft[];
  readonly onDone: (skill: SkillDraft) => void;
  readonly onClose: () => void;
}) => {
  const id = useId();
  const [draft, setDraft] = useState(skill);
  const [tried, setTried] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [pickProblem, setPickProblem] = useState<SkillProblem | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const problem = skillProblem(draft, others);
  const shown = tried ? problem : null;
  const shownProblem = pickProblem ?? shown;
  const errorOf = (field: "name" | "body" | "files"): string | null => {
    const found = field === "files" ? shownProblem : shown;
    return found?.field === field ? t(found.key, found.path === undefined ? undefined : { path: found.path }) : null;
  };

  // Each picked file is checked, then goes up at once; it joins the skill only when core has it.
  const pick = async (picked: readonly File[]): Promise<void> => {
    setPickProblem(null);
    let files: readonly SkillFileDraft[] = draft.files;
    for (const file of picked) {
      const refused = pickedFileProblem(files, file);
      if (refused !== null) {
        setPickProblem(refused);
        continue;
      }
      setUploading((n) => n + 1);
      const sent = await uploadSkillFile(file);
      setUploading((n) => n - 1);
      if (!sent.ok) {
        setPickProblem({ field: "files", key: sent.key, path: file.name });
        continue;
      }
      files = withFile(files, sent.file);
      const added = sent.file;
      setDraft((current) => ({ ...current, files: withFile(current.files, added) }));
    }
  };

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent title={skill.name === "" ? t("agentProfiles.skill.titleNew") : t("agentProfiles.skill.titleEdit")} className="w-full sm:w-[420px]">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-5 pt-5">
          <h2 className="mb-4 text-[16px] font-semibold">{skill.name === "" ? t("agentProfiles.skill.titleNew") : skill.name}</h2>
          <div className="mb-3.5">
            <Label htmlFor={`${id}-name`}>{t("agentProfiles.skill.name")}</Label>
            <Input id={`${id}-name`} value={draft.name} className="font-mono" spellCheck={false} aria-invalid={errorOf("name") !== null}
              onChange={(event) => { setDraft({ ...draft, name: event.target.value }); }} />
            {errorOf("name") === null ? <p className="mt-1.5 text-sm text-faint">{t("agentProfiles.skill.nameHelp")}</p> : <p role="alert" className="mt-1.5 text-sm text-red">{errorOf("name")}</p>}
          </div>
          <div className="mb-3.5">
            <Label htmlFor={`${id}-body`}>{t("agentProfiles.skill.body")}</Label>
            <Textarea id={`${id}-body`} value={draft.body} rows={14} className="min-h-[300px] font-mono text-ui leading-[1.7]" spellCheck={false}
              aria-invalid={errorOf("body") !== null}
              onChange={(event) => { setDraft({ ...draft, body: event.target.value }); }} />
            {errorOf("body") === null ? null : <p role="alert" className="mt-1.5 text-sm text-red">{errorOf("body")}</p>}
          </div>
          <div className="mb-5">
            <div className="mb-1.5 text-sm font-medium text-muted">{t("agentProfiles.skill.files")}</div>
            {draft.files.length === 0 ? null : (
              <ul className="mb-1.5 border-t border-line">
                {draft.files.map((file) => (
                  <li key={file.path} className="flex h-9 items-center gap-2 border-b border-line">
                    <FileIcon aria-hidden className="size-[14px] shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate font-mono text-ui">{file.path}</span>
                    <span className="shrink-0 font-mono text-sm text-faint">{sizeText(file.size)}</span>
                    <RemoveButton label={t("agentProfiles.skill.removeFile", { path: file.path })}
                      onClick={() => { setDraft({ ...draft, files: draft.files.filter((entry) => entry.path !== file.path) }); }} />
                  </li>
                ))}
              </ul>
            )}
            <input ref={picker} type="file" multiple hidden data-testid="skill-file-input" aria-label={t("agentProfiles.skill.addFiles")}
              onChange={(event) => {
                const picked = [...(event.target.files ?? [])];
                event.target.value = "";
                void pick(picked);
              }} />
            <AddButton disabled={uploading > 0} onClick={() => { picker.current?.click(); }}>
              {uploading > 0 ? t("agentProfiles.skill.uploading") : t("agentProfiles.skill.addFiles")}
            </AddButton>
            {errorOf("files") === null ? <p className="mt-1.5 text-sm text-faint">{draft.files.length === 0 ? t("agentProfiles.skill.noFiles") : t("agentProfiles.skill.filesHelp")}</p> : <p role="alert" className="mt-1.5 text-sm text-red">{errorOf("files")}</p>}
          </div>
          <div className="mt-auto flex justify-end">
            <Button variant="primary" disabled={uploading > 0} onClick={() => {
              setTried(true);
              if (problem === null) onDone(draft);
            }}>{t("agentProfiles.skill.done")}</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};

export const SkillsSection = ({ skills, readOnly, onChange, newSkill }: {
  readonly skills: readonly SkillDraft[];
  readonly readOnly: boolean;
  readonly onChange: (skills: readonly SkillDraft[]) => void;
  readonly newSkill: () => SkillDraft;
}) => {
  const [editing, setEditing] = useState<SkillDraft | null>(null);
  return (
    <EditorSection title={t("agentProfiles.editor.skills")} count={skills.length} note={t("agentProfiles.editor.skillsNote")}>
      {skills.length === 0 ? (
        <p className="flex min-h-10 items-center border-y border-line py-2 text-ui text-faint">{t("agentProfiles.editor.noSkills")}</p>
      ) : (
        <ul className="border-t border-line" data-testid="skills">
          {skills.map((skill) => (
            <li key={skill.key} className="flex h-10 items-center gap-3 border-b border-line" data-skill={skill.name}>
              <BookOpenIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-faint" />
              <span className="w-[150px] shrink-0 truncate font-mono text-body">{skill.name}</span>
              <span className="hidden min-w-0 flex-1 truncate text-body text-muted sm:block">{skillDescription(skill.body)}</span>
              <span className="ml-auto shrink-0 font-mono text-sm text-faint sm:ml-0">{filesWord(skill.files.length)}</span>
              {readOnly ? null : (
                <>
                  <Button variant="link" className="shrink-0 text-ui font-normal" onClick={() => { setEditing(skill); }}>{t("agentProfiles.editor.edit")}</Button>
                  <RemoveButton label={t("agentProfiles.editor.remove", { name: skill.name })} onClick={() => { onChange(skills.filter((entry) => entry.key !== skill.key)); }} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {readOnly ? null : <div className="mt-2"><AddButton onClick={() => { setEditing(newSkill()); }}>{t("agentProfiles.editor.addSkill")}</AddButton></div>}
      {editing === null ? null : (
        <SkillSheet
          skill={editing}
          others={skills}
          onClose={() => { setEditing(null); }}
          onDone={(skill) => {
            onChange(skills.some((entry) => entry.key === skill.key) ? skills.map((entry) => (entry.key === skill.key ? skill : entry)) : [...skills, skill]);
            setEditing(null);
          }}
        />
      )}
    </EditorSection>
  );
};
