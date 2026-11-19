import { blobIdSchema } from "@ostra/protocol";
import { z } from "zod";

import type { MessageKey } from "@/lib/messages";

import type { SkillFileDraft } from "./editor-draft";

// A skill's file goes up the moment it is picked (F-021, ticket 42): the panel's upload route hands
// it to core's blob service and answers its blob, which the draft then holds until "Save profile"
// names it in the profile. The route is `apps/web/src/app/api/agent-profiles/skill-files`.

export const SKILL_FILE_UPLOAD_PATH = "/api/agent-profiles/skill-files";

const answerSchema = z.object({ blobId: blobIdSchema, size: z.number().int().min(1) });

export type SkillFileUpload = { readonly ok: true; readonly file: SkillFileDraft } | { readonly ok: false; readonly key: MessageKey };

/** Sends one file's bytes, as its own path in the skill's folder. `send` is `fetch`, or a test's. */
export const uploadSkillFile = async (file: File, send: typeof fetch = fetch): Promise<SkillFileUpload> => {
  try {
    const response = await send(SKILL_FILE_UPLOAD_PATH, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: await file.arrayBuffer(),
    });
    if (response.status === 413) {
      return { ok: false, key: "agentProfiles.skill.errorSize" };
    }
    const answer = response.ok ? answerSchema.safeParse(await response.json()) : undefined;
    if (answer?.success !== true) {
      return { ok: false, key: "agentProfiles.skill.errorUpload" };
    }
    return { ok: true, file: { path: file.name, size: answer.data.size, blobId: answer.data.blobId } };
  } catch {
    return { ok: false, key: "agentProfiles.skill.errorUpload" };
  }
};
