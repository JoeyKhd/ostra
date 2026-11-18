import type { z } from "zod";
import {
  answerRequest,
  answerResponse,
  apiError,
  historyPage,
  interruptRequest,
  interruptResponse,
  loginRequest,
  loginResponse,
  sendRequest,
  sendResponse,
  takeOverRequest,
  takeOverResponse,
  taskInfo,
} from "../shared/api.ts";
import { createFailure, type Failure } from "../shared/failure.ts";
import type { ApprovalId, ClientMessageId, MemberId, OptionId, TaskId } from "../shared/ids.ts";

// The page's side of the API. Every request body is checked against, and every reply parsed with, the
// same schemas the server builds them from (src/shared/api.ts).

export type ApiFailure = Failure<string> & { readonly status: number };

const apiFailure = (status: number, code: string, message: string, details: Readonly<Record<string, string | number | boolean | null>>): ApiFailure =>
  Object.assign(createFailure(code, message, details), { status });

const send = async <S extends z.ZodType>(method: "GET" | "POST", url: string, response: S, body?: unknown): Promise<z.infer<S>> => {
  const reply = await fetch(url, {
    method,
    credentials: "same-origin",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json: unknown = await reply.json();
  if (!reply.ok) {
    const parsed = apiError.safeParse(json);
    if (parsed.success) throw apiFailure(reply.status, parsed.data.error.code, parsed.data.error.message, parsed.data.error.details);
    throw apiFailure(reply.status, "UNKNOWN", "request failed", {});
  }
  return response.parse(json);
};

const get = <S extends z.ZodType>(url: string, response: S): Promise<z.infer<S>> => send("GET", url, response);

const post = <Q extends z.ZodType, S extends z.ZodType>(url: string, request: Q, body: z.input<Q>, response: S): Promise<z.infer<S>> =>
  send("POST", url, response, request.parse(body));

const taskUrl = (taskId: TaskId, rest = ""): string => `/api/tasks/${encodeURIComponent(taskId)}${rest}`;

export const api = {
  login: (memberId: MemberId) => post("/api/dev-login", loginRequest, { memberId }, loginResponse),
  task: (taskId: TaskId) => get(taskUrl(taskId), taskInfo),
  history: (taskId: TaskId, turns: string, before?: number) =>
    get(taskUrl(taskId, `/history?turns=${encodeURIComponent(turns)}${before === undefined ? "" : `&before=${String(before)}`}`), historyPage),
  send: (taskId: TaskId, text: string, clientMessageId: ClientMessageId, interruptFirst: boolean) =>
    post(taskUrl(taskId, "/send"), sendRequest, { text, clientMessageId, ...(interruptFirst ? { interruptFirst: true } : {}) }, sendResponse),
  interrupt: (taskId: TaskId) => post(taskUrl(taskId, "/interrupt"), interruptRequest, {}, interruptResponse),
  takeOver: (taskId: TaskId, expectedVersion: number) => post(taskUrl(taskId, "/take-over"), takeOverRequest, { expectedVersion }, takeOverResponse),
  answer: (taskId: TaskId, approvalId: ApprovalId, optionId: OptionId) =>
    post(taskUrl(taskId, `/approvals/${encodeURIComponent(approvalId)}/answer`), answerRequest, { optionId }, answerResponse),
};
