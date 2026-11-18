// Which inputs this spike can see. It prints names and present/missing, never a value.

import { execFile } from "node:child_process";
import path from "node:path";
import { opensslBin } from "./harness/certs.ts";
import { spike1Rate } from "./harness/spike1-rate.ts";

type Input = { readonly name: string; readonly needFor: string; readonly present: boolean };

const has = (name: string): boolean => {
  const v = process.env[name];
  return v !== undefined && v.length > 0;
};

const runs = (bin: string, args: readonly string[]): Promise<boolean> =>
  new Promise((resolve) => {
    execFile(bin, args, { windowsHide: true }, (err) => {
      resolve(err === null);
    });
  });

const main = async (): Promise<void> => {
  const nginx = process.env["NGINX_BIN"];
  const rate = await spike1Rate(path.resolve(import.meta.dirname, "..", ".."));
  const inputs: Input[] = [
    { name: "openssl CLI (OPENSSL_BIN, or on PATH, or Git for Windows')", needFor: "every criterion (the run's certificates)", present: await runs(await opensslBin(), ["version"]) },
    {
      name: "SPIKE_DATABASE_URL (optional)",
      needFor: "a Postgres of your own (the spike uses only its own schema there); without it, embedded-postgres runs one here",
      present: has("SPIKE_DATABASE_URL"),
    },
    {
      name: "NGINX_BIN",
      needFor: "criterion 1, real nginx with its defaults (the emulation runs without it)",
      present: nginx !== undefined && nginx.length > 0 && (await runs(nginx, ["-v"])),
    },
    {
      name: "spike 1's recorded event rate (OSTRA_SPIKE1_EVENTS_PER_MIN, or spike 1's report.json)",
      needFor: `criterion 4's event rate; found: ${rate.fromSpike1 ? "yes" : "no"}`,
      present: rate.fromSpike1,
    },
    { name: "a Linux machine (this is " + process.platform + ")", needFor: "criterion 4 at full scale, and the Linux leg of every criterion", present: process.platform === "linux" },
    { name: "a macOS machine (this is " + process.platform + ")", needFor: "the macOS leg of every criterion", present: process.platform === "darwin" },
    { name: "OSTRA_DEV_MODEL_BASE_URL / _API_KEY / _ID", needFor: "nothing: this spike calls no model", present: has("OSTRA_DEV_MODEL_BASE_URL") && has("OSTRA_DEV_MODEL_API_KEY") && has("OSTRA_DEV_MODEL_ID") },
  ];
  for (const i of inputs) process.stdout.write(`${i.present ? "present" : "missing"}  ${i.name}\n         for: ${i.needFor}\n`);
  if (has("DATABASE_URL")) process.stdout.write("note     DATABASE_URL is set in this shell; the spike ignores it (it reads SPIKE_DATABASE_URL only)\n");
};

void main();
