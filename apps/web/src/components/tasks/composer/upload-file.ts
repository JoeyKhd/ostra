import { MESSAGE_FILE_FORM_FIELD, MESSAGE_FILE_TASK_FIELD, messageFileUploadPath, recordedUploadSchema, uploadRefusalSchema } from "@ostra/domain/file-uploads";
import type { UploadRefusalCode } from "@ostra/domain/file-uploads";

import { t } from "@/lib/messages";

import type { Uploader } from "./use-attachments";

// The tray's upload (ticket 15; ADR 0070, Q338): one file a request to the web app's route,
// `POST /api/projects/<projectId>/files`, as `FormData` (`file`, and `taskId` on a task's page),
// through `XMLHttpRequest`, the one browser API that says how far an upload got. The route answers
// core's view of the stored file, or a refusal's code, which the panel words itself.

/** A refusal's code in the panel's words, for the failed chip's tooltip. */
export const refusalWords = (code: UploadRefusalCode): string => {
  switch (code) {
    case "unauthorized":
      return t("task.composer.attach.refused.unauthorized");
    case "forbidden":
      return t("task.composer.attach.refused.forbidden");
    case "not-found":
      return t("task.composer.attach.refused.notFound");
    case "not-a-form":
    case "no-file":
    case "bad-request":
      return t("task.composer.attach.refused.badRequest");
    case "empty":
      return t("task.composer.attach.refused.empty");
    case "too-large":
      return t("task.composer.attach.refused.tooLarge");
    case "too-many-unsent":
      return t("task.composer.attach.refused.tooManyUnsent");
    case "unavailable":
      return t("task.composer.attach.refused.unavailable");
    default:
      return code satisfies never;
  }
};

/** What a finished request answered: the stored file, a refusal in words, or a failure the tray retries. */
export const uploadAnswerOf = (status: number, body: string): Awaited<ReturnType<Uploader>> | null => {
  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (status >= 200 && status < 300) {
    const stored = recordedUploadSchema.safeParse(json);
    return stored.success ? { kind: "uploaded", file: stored.data } : null;
  }
  const refused = uploadRefusalSchema.safeParse(json);
  return refused.success ? { kind: "refused", reason: refusalWords(refused.data.error.code) } : null;
};

/** The uploader for a project's box, and a task's on its page. */
export const projectUploader = (projectId: string, taskId: string | null): Uploader => (file, { signal, onProgress }) =>
  new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", messageFileUploadPath(projectId));
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      const answer = uploadAnswerOf(request.status, request.responseText);
      if (answer === null) reject(new Error(`upload answered ${String(request.status)}`));
      else resolve(answer);
    };
    request.onerror = () => { reject(new Error("upload failed")); };
    request.onabort = () => { reject(new Error("upload aborted")); };
    signal.addEventListener("abort", () => { request.abort(); });
    const form = new FormData();
    form.append(MESSAGE_FILE_FORM_FIELD, file);
    if (taskId !== null) form.append(MESSAGE_FILE_TASK_FIELD, taskId);
    request.send(form);
  });
