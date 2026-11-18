// Packet capture for T1, Linux only: `tcpdump -i any` around a turn, then a
// read of the capture for any packet to or from an address outside loopback.
// Needs tcpdump and CAP_NET_RAW (root in the spike's container). Unlike the
// egress recorder, it sees every client, proxy-aware or not.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type CaptureResult = {
  /** Packets in the capture, loopback included: the positive control. */
  readonly packets: number;
  /** Packets to or from anything outside 127.0.0.0/8 and ::1, as tcpdump prints them (addresses and ports, no payload). */
  readonly outside: readonly string[];
};

export type Capture = { readonly stop: () => Promise<CaptureResult> };

const LOOPBACK_FILTER = "not (net 127.0.0.0/8 or ip6 host ::1)";

const lines = (text: string): string[] => text.split("\n").filter((l) => l.trim() !== "");

/** Starts a capture into `file`. Throws when tcpdump can't start (missing, or no permission). */
export const startCapture = async (file: string): Promise<Capture> => {
  const child = spawn("tcpdump", ["-i", "any", "-n", "-U", "-w", file], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      resolve(code);
    });
    child.once("error", () => {
      resolve(-1);
    });
  });
  // tcpdump says "listening on any" once it captures.
  const deadline = Date.now() + 10_000;
  while (!stderr.includes("listening on")) {
    const early = await Promise.race([exited, new Promise<"waiting">((resolve) => setTimeout(() => {
      resolve("waiting");
    }, 100))]);
    if (early !== "waiting") throw new Error(`tcpdump did not start (exit ${String(early)}): ${stderr.trim().slice(0, 200)}`);
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("tcpdump did not report listening within 10 s");
    }
  }
  return {
    stop: async () => {
      // Let the last packets land, then stop; -U flushes per packet.
      await new Promise((resolve) => setTimeout(resolve, 500));
      child.kill("SIGINT");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
      const all = lines((await run("tcpdump", ["-n", "-r", file], { maxBuffer: 64 * 1024 * 1024 })).stdout);
      const outside = lines((await run("tcpdump", ["-n", "-r", file, LOOPBACK_FILTER], { maxBuffer: 64 * 1024 * 1024 })).stdout);
      return { packets: all.length, outside };
    },
  };
};
