// T1 Offline, pinned install: with egress allowed only to the model proxy, a
// session starts and runs a turn; nothing goes to the ACP registry, GitHub,
// npm or models.dev; the reported OpenCode version is the pinned one.
// Everywhere, egress is watched by a deny-all forward proxy in the agent's
// HTTP(S)_PROXY, proven by a webfetch control. On Linux (the spike's
// container, behind its egress firewall), tcpdump also captures every packet
// during the turn, and the capture must hold nothing outside loopback.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { textPrompt } from "../lib/acp-driver.ts";
import { startEgressRecorder } from "../lib/egress-recorder.ts";
import { startCapture, type Capture } from "../lib/packet-capture.ts";
import { stubMarker } from "../lib/stub-models/scenario.ts";
import { errorMessage, newSession, withTask, withTimeout, type CaseContext } from "../harness/fixture.ts";
import { check, fail, skip, type Check, type Criterion } from "../harness/report.ts";

const pkg = z.looseObject({ dependencies: z.record(z.string(), z.string()), devDependencies: z.record(z.string(), z.string()) });

const CAPTURE_CHECK = "packet capture shows no request to the ACP registry CDN, GitHub, npm or models.dev";

export const t1Offline = async (ctx: CaseContext): Promise<Criterion[]> => {
  const checks: Check[] = [];
  const recorded: Record<string, string | number> = {};
  const rawManifest: unknown = JSON.parse(await readFile(path.resolve(import.meta.dirname, "..", "..", "package.json"), "utf8"));
  const manifest = pkg.parse(rawManifest);
  const pinned = manifest.dependencies["@opencode/cli"] ?? "?";
  const egress = await startEgressRecorder();
  let captureCheck: Check | undefined;
  try {
    await withTask(ctx, { name: "t1", upstream: { kind: "stub", format: "openai" }, extraEnv: egress.env }, async (task) => {
      recorded["binary"] = `${task.binary.packageName}@${task.binary.packageVersion}`;
      recorded["binary sha256"] = task.binary.sha256;
      const reported = task.driver.initialize.agentInfo?.version ?? "none";
      checks.push(
        check(
          "the reported OpenCode version is the pinned one",
          reported === pinned && task.binary.packageVersion === pinned,
          `package.json pins ${pinned}; the binary's package is ${task.binary.packageVersion}; initialize reports ${reported}`,
        ),
      );
      // Linux: capture every packet from the session's start to the end of the turn.
      let capture: Capture | undefined;
      if (process.platform === "linux") {
        try {
          capture = await startCapture(path.join(ctx.runRoot, "t1.pcap"));
        } catch (error) {
          captureCheck = skip(CAPTURE_CHECK, `tcpdump with CAP_NET_RAW (${errorMessage(error)}); run inside container/run.sh`);
        }
      }
      const sessionId = await newSession(task);
      const response = await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("edit-file", "README.md")} edit the readme`)), 120_000, "offline turn");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (capture !== undefined) {
        const result = await capture.stop();
        recorded["packets captured during the turn (loopback included)"] = result.packets;
        captureCheck = check(
          CAPTURE_CHECK,
          result.packets > 0 && result.outside.length === 0 && response.stopReason === "end_turn",
          result.packets === 0
            ? "the capture holds no packet at all, not even the turn's own loopback calls: it proves nothing"
            : `${String(result.packets)} packets during the turn, ${String(result.outside.length)} outside loopback${result.outside.length === 0 ? "" : `: ${result.outside.slice(0, 5).join(" / ")}`}`,
        );
      }
      const during = [...egress.attempts];
      recorded["egress attempts during the session"] = during.length === 0 ? "none" : [...new Set(during.map((a) => a.host))].join(", ");

      // Positive control: the recorder must see OpenCode's own outbound HTTP, or its silence proves nothing.
      await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("webfetch", "https://egress-control.invalid/")} fetch it`)), 60_000, "control turn");
      const control = egress.attempts.some((a) => a.host.includes("egress-control.invalid"));
      recorded["recorder positive control (webfetch seen)"] = String(control);
      if (!control) {
        checks.push(skip("with egress allowed only to the model proxy, a session starts and runs a turn with no other egress", "packet capture: OpenCode ignored HTTP(S)_PROXY, so the recorder can't see its traffic; run in a Linux container with an egress firewall"));
      } else {
        checks.push(
          check(
            "with egress allowed only to the model proxy, a session starts and runs a turn with no other egress",
            response.stopReason === "end_turn" && during.length === 0,
            `stopReason=${response.stopReason}; ${String(during.length)} outbound attempts outside the proxy (recorder verified by a webfetch control)`,
          ),
        );
      }
    });
  } catch (error) {
    checks.push(fail("the offline turn", errorMessage(error)));
  }
  checks.push(
    captureCheck ??
      (process.platform === "linux"
        ? fail(CAPTURE_CHECK, "the capture did not run")
        : skip(CAPTURE_CHECK, "Linux with tcpdump: container/run.sh (the egress recorder above only sees proxy-aware clients)")),
  );

  // Control: OpenCode 1.19.6 with the same egress recorder, recorded only.
  const before = egress.attempts.length;
  try {
    await withTask(ctx, { name: "t1-v1", upstream: { kind: "stub", format: "openai" }, line: "v1", extraEnv: egress.env }, async (task) => {
      const sessionId = await newSession(task);
      await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("hello")} hi`)), 120_000, "v1 turn");
      await new Promise((resolve) => setTimeout(resolve, 3000));
    });
    const v1 = egress.attempts.slice(before);
    recorded["control 1.19.6 egress attempts"] = v1.length === 0 ? "none" : [...new Set(v1.map((a) => a.host))].join(", ");
  } catch (error) {
    recorded["control 1.19.6 egress attempts"] = `error: ${errorMessage(error)}`;
  }
  await egress.close();
  return [{ id: "T1", title: "Offline, pinned install: a turn with egress only to the proxy; no other requests; pinned version reported.", checks, recorded }];
};
