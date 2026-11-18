import { z } from "zod";
import { SERVER_MINOR } from "../../protocol/messages.ts";
import { runner, waitWelcome, type Ctx, type Replica } from "../cluster.ts";
import { num, str } from "../procs.ts";
import { check, type Check } from "../report.ts";
import { describeVerify, streamOnce } from "./common.ts";

/**
 * Criterion 5: runners at minors N-2 .. N+2 against a server at N (= 2).
 * N-1, N and N+1 must work (with fields encoded down); N-2 and N+2 must be
 * refused with a message that names the fix, and retry slowly.
 */
export const versions = async (ctx: Ctx, replicas: readonly Replica[]): Promise<Check[]> => {
  const a = replicas[0];
  if (a === undefined) return [];
  const url = `https://localhost:${String(a.port)}`;
  const checks: Check[] = [];
  const cases: { minor: number; transport: "websocket" | "http"; works: boolean }[] = [
    { minor: SERVER_MINOR - 1, transport: "websocket", works: true },
    { minor: SERVER_MINOR, transport: "websocket", works: true },
    { minor: SERVER_MINOR + 1, transport: "websocket", works: true },
    { minor: SERVER_MINOR - 1, transport: "http", works: true },
    { minor: SERVER_MINOR + 1, transport: "http", works: true },
    { minor: SERVER_MINOR - 2, transport: "websocket", works: false },
    { minor: SERVER_MINOR + 2, transport: "websocket", works: false },
    { minor: SERVER_MINOR + 2, transport: "http", works: false },
  ];
  for (const c of cases) {
    const name = `runner minor ${String(c.minor)} vs server minor ${String(SERVER_MINOR)} over ${c.transport}`;
    const id = `ver-${String(c.minor)}-${c.transport}`;
    const r = runner(ctx, { id, serverUrl: url, args: [`--minor=${String(c.minor)}`, `--transport=${c.transport}`, "--events-per-sec=10"] });
    try {
      if (c.works) {
        const w = await waitWelcome(r.child, 20_000);
        if (w === undefined) {
          checks.push(check(name, false, "no welcome"));
          continue;
        }
        const st = await streamOnce(ctx, r, id, 1_500);
        const statusRow = await ctx.db.query("SELECT status FROM runner WHERE id = $1", [id]);
        const status = z.object({ status: z.record(z.string(), z.unknown()).nullable() }).safeParse(statusRow.rows[0]);
        const keys = status.success && status.data.status !== null ? Object.keys(status.data.status).sort() : [];
        // What the server got must be exactly the negotiated minor's shape.
        const negotiated = num(w, "minor") ?? -1;
        const wantLabels = negotiated >= 2;
        const shapeOk = keys.includes("labels") === wantLabels && !keys.includes("spoolBytes");
        checks.push(
          check(
            name,
            st.verify?.ok === true && st.steerReceived && negotiated === Math.min(SERVER_MINOR, c.minor) && shapeOk,
            `works at negotiated minor ${String(negotiated)}; ${describeVerify(st.verify)}; steer ${st.steerReceived ? "received" : "lost"}; status stored with fields [${keys.join(", ")}]`,
          ),
        );
      } else {
        const refused = await r.child.waitFor((l) => l["t"] === "version-refused", 20_000);
        const welcomed = r.child.lines.some((l) => l["t"] === "welcome");
        const clear =
          refused?.["level"] === "error" &&
          (str(refused, "fix") ?? "").includes("/runner/v1/info") &&
          num(refused, "supportedMin") === SERVER_MINOR - 1 &&
          num(refused, "supportedMax") === SERVER_MINOR + 1 &&
          num(refused, "retryInMs") === 300_000 / ctx.timeScale;
        checks.push(
          check(
            name,
            !welcomed && clear,
            refused === undefined
              ? "never refused"
              : `refused at error level: server ${String(num(refused, "serverMinor"))} accepts ${String(num(refused, "supportedMin"))}..${String(num(refused, "supportedMax"))}; fix: "${str(refused, "fix") ?? ""}"; retries in ${String(num(refused, "retryInMs"))} ms`,
          ),
        );
      }
    } finally {
      await r.child.kill9();
    }
  }
  return checks;
};
