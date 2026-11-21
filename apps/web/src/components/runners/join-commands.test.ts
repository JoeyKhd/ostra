import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { fleetSettings } from "@/server/fleet-settings";

import { joinCommand } from "./join-commands";
import type { JoinCommandInput } from "./join-commands";

// Milestone 7's ticket 30 (F-039's publishing, ADR 0064): the pool's join commands start the
// server's own release of the runner, as that release published it: the CLI under its npm name, the
// runner image under its image namespace, and the runner chart the release attached. A clone's
// `ostra` names would pull what no release pushed.

/** The root package.json, which the release's stamp writes: on a stamped tree (release.yml's), the release's names. */
const root = z
  .looseObject({ version: z.string(), imageNamespace: z.string(), cliPackage: z.string() })
  .parse(JSON.parse(await readFile(new URL("../../../../../package.json", import.meta.url), "utf8")));

const release: JoinCommandInput = { serverUrl: "https://core.acme.dev", serverVersion: "1.0.0-rc.0", imageNamespace: "localhost:5000/ostra", cliPackage: "@acme/ostra-cli", executor: "docker" };

describe("the join commands", () => {
  it("F-039/c2: each starts the server's own release: the CLI by its npm name, the runner image under the release's namespace, and the runner chart the release attached", () => {
    expect(joinCommand("cli", release)).toBe(["OSTRA_JOIN_TOKEN_FILE=./join-token \\", "  npx @acme/ostra-cli@1.0.0-rc.0 runner \\", "  --server https://core.acme.dev \\", "  --executor docker"].join("\n"));
    expect(joinCommand("docker", release).split("\n").at(-1)).toBe("  localhost:5000/ostra/runner:1.0.0-rc.0 runner");
    const helm = joinCommand("helm", { ...release, executor: "kubernetes" }).split("\n");
    expect(helm.slice(0, 2)).toEqual([
      "# kubectl -n ostra create secret generic ostra-join-token --from-file=join-token=./join-token",
      "# helm install ostra-runner https://github.com/JoeyKhd/ostra/releases/download/v1.0.0-rc.0/ostra-runner.tgz -n ostra -f values.yaml",
    ]);
    expect(helm.join("\n")).not.toContain("./deploy/helm");
  });

  it("F-039/c2: a development build (0.0.0), which no release publishes, installs the chart from a clone, and says so", () => {
    const helm = joinCommand("helm", { ...release, serverVersion: "0.0.0" }).split("\n");
    expect(helm.slice(1, 3)).toEqual(["# A development build (0.0.0), which no release publishes: install the chart from your clone of ostra.", "# helm install ostra-runner ./deploy/helm/ostra-runner -n ostra -f values.yaml"]);
    expect(helm.join("\n")).not.toContain("releases/download");
  });

  it("F-039/c2: the panel reads the version, the image namespace and the CLI's name the release's stamp wrote, and they reach every command", () => {
    const settings = fleetSettings();
    expect({ version: settings.serverVersion, imageNamespace: settings.imageNamespace, cliPackage: settings.cliPackage }).toEqual({ version: root.version, imageNamespace: root.imageNamespace, cliPackage: root.cliPackage });
    const input = { ...settings, executor: "docker" } as const;
    expect(joinCommand("cli", input)).toContain(`\n  npx ${root.cliPackage}@${root.version} runner \\\n`);
    expect(joinCommand("docker", input).split("\n").at(-1)).toBe(`  ${root.imageNamespace}/runner:${root.version} runner`);
    expect(joinCommand("helm", input)).toContain(root.version === "0.0.0" ? " ./deploy/helm/ostra-runner " : ` https://github.com/JoeyKhd/ostra/releases/download/v${root.version}/ostra-runner.tgz `);
  });
});
