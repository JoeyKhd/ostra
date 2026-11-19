import { infoResponseSchema, PROTOCOL_MAJOR, PROTOCOL_MINOR, runnerHeaders, runnerPaths } from "@ostra/protocol";
import type { InfoResponse } from "@ostra/protocol";
import { RUNNER_VERSION } from "../version.ts";
import { callJson, joinUrl } from "./http.ts";
import type { CallFailure } from "./http.ts";

// `GET /runner/v1/info`: the first thing a runner reads (ADR 0034). It says which protocol minors
// the server accepts and where the panel is for the device flow.

export type InfoResult =
  | { readonly ok: true; readonly info: InfoResponse }
  | { readonly ok: false; readonly reason: "unreachable"; readonly failure: CallFailure }
  | { readonly ok: false; readonly reason: "version"; readonly info: InfoResponse; readonly fix: string };

/** Whether this build's protocol version is inside the server's window. */
export const versionAccepted = (info: InfoResponse): boolean =>
  info.protocolMajor === PROTOCOL_MAJOR && PROTOCOL_MINOR >= info.supported.min && PROTOCOL_MINOR <= info.supported.max;

/** What to do when the server refuses this build's version (F-061): install the server's own. */
export const versionFix = (info: InfoResponse): string =>
  `This runner (ostra ${RUNNER_VERSION}, protocol ${String(PROTOCOL_MAJOR)}.${String(PROTOCOL_MINOR)}) is outside the ` +
  `server's window (protocol ${String(info.protocolMajor)}.${String(info.supported.min)} to ` +
  `${String(info.protocolMajor)}.${String(info.supported.max)}). Install ostra ${info.serverVersion}, the server's ` +
  `version, and start the runner again.`;

export const fetchInfo = async (serverUrl: string, signal?: AbortSignal): Promise<InfoResult> => {
  const result = await callJson({
    url: joinUrl(serverUrl, runnerPaths.info),
    method: "GET",
    schema: infoResponseSchema,
    // Minor 4: the server answers in this minor's shape, with the window and the pin's registry.
    headers: { [runnerHeaders.minor]: String(PROTOCOL_MINOR) },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!result.ok) {
    return { ok: false, reason: "unreachable", failure: result.failure };
  }
  if (!versionAccepted(result.value)) {
    return { ok: false, reason: "version", info: result.value, fix: versionFix(result.value) };
  }
  return { ok: true, info: result.value };
};
