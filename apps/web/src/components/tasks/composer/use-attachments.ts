"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import type { RecordedUpload } from "@ostra/domain/file-uploads";
import type { FileLimits } from "@ostra/domain/file-limits";
import type { MessageFileId } from "@ostra/protocol";

import { t } from "@/lib/messages";

import { admitFiles, lookOfType, refusalText, sendStateOf, sendsNow, trayHintOf } from "./attach-words";
import type { SendState, TrayEntry, TrayHint, TrayRefusal } from "./attach-words";

// The tray's state (composer-attachments.md; F-148, ticket 15): the files in the message box, each
// checked against the server's limits as it arrives and uploaded the moment it joins (one request a
// file, several in flight), with its progress, its answer or its failure; paste and drop add to it;
// a press of Send while files upload waits, and sends once the last one lands. A picture shows from
// the browser's own copy (a `blob:` URL), never the server. The upload itself is the caller's
// (`POST /api/projects/<projectId>/files`), so the box and its tests run without one.

/** What one upload answered: core's view of the stored file, or the server's refusal in words. */
export type UploadOutcome = { readonly kind: "uploaded"; readonly file: RecordedUpload } | { readonly kind: "refused"; readonly reason: string };

/** Uploads one file, saying how far it got; throws when the request itself failed. */
export type Uploader = (file: File, options: { readonly signal: AbortSignal; readonly onProgress: (fraction: number) => void }) => Promise<UploadOutcome>;

/** One file in the tray. */
export type TrayItem = TrayEntry<RecordedUpload> & {
  /** The tray's own key for it. */
  readonly key: string;
  readonly file: File;
  /** The browser's copy of a picture, for its square and the viewer. */
  readonly previewUrl: string | null;
};

export type TrayState = {
  readonly items: readonly TrayItem[];
  /** The newest file the tray didn't take, until it's dismissed or another arrives. */
  readonly refusal: TrayRefusal | null;
  /** Send was pressed while files upload: it sends when the last lands. */
  readonly pressed: boolean;
  /** The polite live region's line: `spec.docx added`, `spec.docx uploaded`, a refusal. */
  readonly announcement: string;
};

export const emptyTray: TrayState = { items: [], refusal: null, pressed: false, announcement: "" };

export type TrayAction =
  | { readonly type: "add"; readonly items: readonly TrayItem[]; readonly refusal: TrayRefusal | null }
  | { readonly type: "progress"; readonly key: string; readonly progress: number }
  | { readonly type: "uploaded"; readonly key: string; readonly file: RecordedUpload }
  | { readonly type: "failed"; readonly key: string; readonly reason: string | null }
  | { readonly type: "retry"; readonly key: string }
  | { readonly type: "remove"; readonly key: string }
  | { readonly type: "dismiss" }
  | { readonly type: "press" }
  | { readonly type: "unpress" }
  | { readonly type: "clear" }
  | { readonly type: "restart" };

const update = (items: readonly TrayItem[], key: string, change: (item: TrayItem) => TrayItem): readonly TrayItem[] => items.map((item) => (item.key === key ? change(item) : item));

/** The tray's changes, pure: what the hook dispatches as files arrive, upload, fail and go. */
export const trayReducer = (state: TrayState, action: TrayAction): TrayState => {
  switch (action.type) {
    case "add": {
      const added = action.items.map((item) => t("task.composer.attach.added", { name: item.name }));
      const said = [...added, ...(action.refusal === null ? [] : [refusalText(action.refusal)])].join(" ");
      return { ...state, items: [...state.items, ...action.items], refusal: action.refusal ?? state.refusal, announcement: said === "" ? state.announcement : said };
    }
    case "progress":
      return { ...state, items: update(state.items, action.key, (item) => (item.upload.state === "uploading" ? { ...item, upload: { state: "uploading", progress: Math.max(item.upload.progress, Math.min(1, action.progress)) } } : item)) };
    case "uploaded": {
      const item = state.items.find((one) => one.key === action.key);
      if (item?.upload.state !== "uploading") return state;
      // Core told the kind by the bytes: a picture the browser named one may be a file, and its name is the safe one.
      const look = action.file.kind === "image" && item.previewUrl !== null ? "image" : "file";
      return {
        ...state,
        items: update(state.items, action.key, (one) => ({ ...one, name: action.file.name, size: action.file.size, look, upload: { state: "ready", uploaded: action.file } })),
        announcement: t("task.composer.attach.uploaded", { name: action.file.name }),
      };
    }
    case "failed": {
      const item = state.items.find((one) => one.key === action.key);
      if (item?.upload.state !== "uploading") return state;
      // A failed upload stops a waiting Send: it's retried or removed first.
      return { ...state, pressed: false, items: update(state.items, action.key, (one) => ({ ...one, upload: { state: "failed", reason: action.reason } })), announcement: t("task.composer.attach.didntUpload", { name: item.name }) };
    }
    case "retry":
      return { ...state, items: update(state.items, action.key, (item) => (item.upload.state === "failed" ? { ...item, upload: { state: "uploading", progress: 0 } } : item)) };
    case "remove": {
      const items = state.items.filter((item) => item.key !== action.key);
      return { ...state, items, pressed: state.pressed && items.length > 0 };
    }
    case "dismiss":
      return { ...state, refusal: null };
    case "press":
      return { ...state, pressed: true };
    case "unpress":
      return { ...state, pressed: false };
    case "restart":
      // The box's project changed: every file uploads again, to the new project.
      return { ...state, pressed: false, items: state.items.map((item) => ({ ...item, upload: { state: "uploading", progress: 0 } })) };
    case "clear":
      return { ...emptyTray, announcement: state.announcement };
    default:
      return action satisfies never;
  }
};

/** The uploaded files' IDs, in the tray's order. */
const idsOf = (items: readonly TrayItem[]): readonly MessageFileId[] => items.flatMap((item) => (item.upload.state === "ready" ? [item.upload.uploaded.fileId] : []));

export type Attachments = {
  readonly items: readonly TrayItem[];
  readonly refusal: TrayRefusal | null;
  readonly announcement: string;
  readonly hint: TrayHint;
  /** Whether the tray holds as many files as a message may: the paperclip turns off. */
  readonly full: boolean;
  /** Send was pressed and waits for uploads: the box is locked. */
  readonly waiting: boolean;
  /** The uploaded files' IDs, in the tray's order, for `tasks.create`, `send` or `reopen`. */
  readonly fileIds: readonly MessageFileId[];
  readonly add: (files: readonly File[], folders?: ReadonlySet<File>) => void;
  readonly remove: (key: string) => void;
  readonly retry: (key: string) => void;
  readonly dismiss: () => void;
  /** Empties the tray once its message went: its files belong to the message now. */
  readonly clear: () => void;
  /** Uploads every file again (the new-task box's project changed: an upload belongs to its project). */
  readonly restart: () => void;
  /** Send's state, for its label and whether it's enabled. */
  readonly sendState: (text: string) => SendState;
  /**
   * Presses Send: `send` runs with the files' IDs now, or once the last upload lands; pressed again
   * while it waits, it goes back to editing.
   */
  readonly press: (send: (fileIds: readonly MessageFileId[]) => void) => void;
  /** Escape while it waits: back to editing. */
  readonly cancel: () => void;
};

export const useAttachments = ({ limits, upload, discard, enabled = true, wordsRequired = false }: {
  /** The server's limits (`files.limits`). */
  readonly limits: FileLimits;
  readonly upload: Uploader;
  /** Deletes an uploaded, unsent file the member removed (`files.discard`). */
  readonly discard: (fileId: MessageFileId) => void;
  /** Whether the member may send here: a viewer's box takes no files. */
  readonly enabled?: boolean;
  /** The new task's box: files alone don't start a task. */
  readonly wordsRequired?: boolean;
}): Attachments => {
  const [state, dispatch] = useReducer(trayReducer, emptyTray);
  const controllers = useRef(new Map<string, AbortController>());
  // The items as the next render will hold them, so two adds in one tick both count.
  const held = useRef<readonly TrayItem[]>([]);
  const counter = useRef(0);
  const pending = useRef<((fileIds: readonly MessageFileId[]) => void) | null>(null);
  const uploadRef = useRef(upload);
  useEffect(() => {
    uploadRef.current = upload;
  }, [upload]);
  useEffect(() => {
    held.current = state.items;
  }, [state.items]);

  const start = useCallback((item: Pick<TrayItem, "key" | "file">) => {
    const controller = new AbortController();
    controllers.current.set(item.key, controller);
    uploadRef.current(item.file, { signal: controller.signal, onProgress: (progress) => { dispatch({ type: "progress", key: item.key, progress }); } }).then(
      (outcome) => {
        if (controller.signal.aborted) return;
        controllers.current.delete(item.key);
        switch (outcome.kind) {
          case "uploaded":
            dispatch({ type: "uploaded", key: item.key, file: outcome.file });
            break;
          case "refused":
            dispatch({ type: "failed", key: item.key, reason: outcome.reason });
            break;
          default:
            outcome satisfies never;
        }
      },
      () => {
        if (controller.signal.aborted) return;
        controllers.current.delete(item.key);
        dispatch({ type: "failed", key: item.key, reason: null });
      },
    );
  }, []);

  const add = useCallback(
    (files: readonly File[], folders?: ReadonlySet<File>) => {
      if (!enabled || state.pressed || files.length === 0) return;
      const arrivals = files.map((file) => ({ name: file.name, size: file.size, folder: folders?.has(file) ?? false, file }));
      const { admitted, refusal } = admitFiles(held.current, arrivals, limits);
      const items = admitted.map((arrival): TrayItem => {
        counter.current += 1;
        const look = lookOfType(arrival.file.type);
        return {
          key: `tray-${String(counter.current)}`,
          file: arrival.file,
          name: arrival.name,
          size: arrival.size,
          look,
          previewUrl: look === "image" ? URL.createObjectURL(arrival.file) : null,
          upload: { state: "uploading", progress: 0 },
        };
      });
      held.current = [...held.current, ...items];
      dispatch({ type: "add", items, refusal });
      for (const item of items) start(item);
    },
    [enabled, limits, start, state.pressed],
  );

  const remove = useCallback(
    (key: string) => {
      const item = held.current.find((one) => one.key === key);
      if (item === undefined) return;
      controllers.current.get(key)?.abort();
      controllers.current.delete(key);
      if (item.previewUrl !== null) URL.revokeObjectURL(item.previewUrl);
      if (item.upload.state === "ready") discard(item.upload.uploaded.fileId);
      held.current = held.current.filter((one) => one.key !== key);
      dispatch({ type: "remove", key });
    },
    [discard],
  );

  const retry = useCallback(
    (key: string) => {
      const item = held.current.find((one) => one.key === key);
      if (item?.upload.state !== "failed") return;
      dispatch({ type: "retry", key });
      start(item);
    },
    [start],
  );

  const clear = useCallback(() => {
    // The files went with the message: their uploads are the message's now. Their previews draw the
    // message until its stored files arrive, so they go a minute later.
    const previews = held.current.flatMap((item) => (item.previewUrl === null ? [] : [item.previewUrl]));
    if (previews.length > 0) setTimeout(() => { for (const url of previews) URL.revokeObjectURL(url); }, 60_000);
    held.current = [];
    pending.current = null;
    dispatch({ type: "clear" });
  }, []);

  // A waiting Send goes once the last upload lands, and stops when one fails.
  const { items, pressed } = state;
  useEffect(() => {
    if (!pressed) {
      pending.current = null;
      return;
    }
    if (!sendsNow(items)) return;
    const send = pending.current;
    pending.current = null;
    dispatch({ type: "unpress" });
    send?.(idsOf(items));
  }, [items, pressed]);

  // Leaving the page aborts what's in flight and lets the previews go; the server deletes unsent uploads after a day.
  useEffect(() => {
    const running = controllers.current;
    return () => {
      for (const controller of running.values()) controller.abort();
      for (const item of held.current) if (item.previewUrl !== null) URL.revokeObjectURL(item.previewUrl);
    };
  }, []);

  const press = useCallback(
    (send: (fileIds: readonly MessageFileId[]) => void) => {
      if (state.pressed) {
        dispatch({ type: "unpress" });
        return;
      }
      if (sendsNow(state.items)) {
        send(idsOf(state.items));
        return;
      }
      if (state.items.some((item) => item.upload.state === "failed")) return;
      pending.current = send;
      dispatch({ type: "press" });
    },
    [state.items, state.pressed],
  );

  const restart = useCallback(() => {
    for (const item of held.current) {
      controllers.current.get(item.key)?.abort();
      controllers.current.delete(item.key);
      if (item.upload.state === "ready") discard(item.upload.uploaded.fileId);
    }
    held.current = held.current.map((item) => ({ ...item, upload: { state: "uploading", progress: 0 } }));
    dispatch({ type: "restart" });
    for (const item of held.current) start(item);
  }, [discard, start]);
  const dismiss = useCallback(() => { dispatch({ type: "dismiss" }); }, []);
  const cancel = useCallback(() => { dispatch({ type: "unpress" }); }, []);
  const fileIds = useMemo(() => idsOf(state.items), [state.items]);
  return {
    items: state.items,
    refusal: state.refusal,
    announcement: state.announcement,
    hint: trayHintOf(state.items, limits, state.refusal),
    full: state.items.length >= limits.maxFiles,
    waiting: state.pressed,
    fileIds,
    add,
    remove,
    retry,
    dismiss,
    clear,
    restart,
    sendState: (text: string) => sendStateOf({ entries: state.items, text, pressed: state.pressed, wordsRequired }),
    press,
    cancel,
  };
};
