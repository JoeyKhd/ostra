import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { tamperToken } from "@ostra/adapter-sdk/testing";
import {
  memberIdSchema,
  organizationIdSchema,
  previewIdSchema,
  previewKeySchema,
  previewLinkIdSchema,
  previewViewIdSchema,
  repoIdSchema,
  reservedPortNames,
  taskIdSchema,
} from "@ostra/protocol";
import type { PreviewKey, ReservedPorts } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { auditActions } from "./audit/actions.ts";
import { detectEnvironment } from "./environment/detect.ts";
import { readDevcontainerPorts, readGitpodPorts, readPackageScripts, readPortScripts, readReplitPorts, readViteConfig } from "./environment/detect-app.ts";
import { jobKey, jobNames, jobSending, parseJobPayload } from "./jobs.ts";
import { transitionAppProcess, transitionLeasePurpose, transitionPreviewLink, transitionPreviewView, previewLinkFromRow } from "./lifecycles/m8-previews.ts";
import type { AppProcessInput, AppProcessLifecycle, PreviewLinkInput, PreviewLinkLifecycle, PreviewViewInput, PreviewViewLifecycle } from "./lifecycles/m8-previews.ts";
import { previewAccess, previewAccessWords, previewLevelChoices } from "./previews/access.ts";
import type { PreviewAccessRefusal, PreviewLinkFacts } from "./previews/access.ts";
import { appProcessListIssues, appProcessListSchema, appProcessSchema, readyCheckFromColumns, screenshotSettingsSchema, specAppProcesses, specScreenshots, appProcessToRow } from "./previews/app-processes.ts";
import { parsePreviewHost, PREVIEW_COOKIE, previewHost, rewriteRequest, rewriteResponse } from "./previews/host.ts";
import { appAddresses, mayReach, previewTargets } from "./previews/targets.ts";
import {
  checkPreviewCode,
  createPanelPreviewTokens,
  issuePreviewCode,
  newPreviewLinkToken,
  previewLinkTokenHash,
  previewLinkTokenMatches,
  PREVIEW_CODE_TTL_MS,
  REPLICA_SIGNATURE_MAX_AGE_MS,
  signReplicaRequest,
  verifyReplicaRequest,
} from "./previews/tokens.ts";
import { PREVIEW_WATCHED_WITHIN_MS, warmHold } from "./previews/warm.ts";
import { parseServerSettings } from "./settings.ts";

// Milestone 8's preview contracts (ticket 05, spec section 5.4, ADR 0068): the environment's app
// processes and their rules, detection's readers, the in-box addresses, the reach rule, the warm
// hold, who may open a preview, the native preview's hosts and rewrites, the tokens, the lifecycles,
// the jobs, the audit actions and the settings.

const at = Date.UTC(2026, 10, 21, 12);
const MINUTE = 60_000;
const repoId = repoIdSchema.parse(randomUUID());
const otherRepoId = repoIdSchema.parse(randomUUID());
const taskId = taskIdSchema.parse(randomUUID());
const memberId = memberIdSchema.parse(randomUUID());
const otherMemberId = memberIdSchema.parse(randomUUID());
const linkId = previewLinkIdSchema.parse(randomUUID());
const viewId = previewViewIdSchema.parse(randomUUID());
const webKey: PreviewKey = previewKeySchema.parse("app-web");
const previewId = previewIdSchema.parse("abcdefghijklmnopqrstuvwx23");

const web = { name: "web", repoId, folder: ".", command: "pnpm dev", port: 5173, ready: { kind: "http", path: "/" }, label: "Web", primary: true, hostRewrite: true } as const;
const api = { name: "api", repoId, folder: "api", command: "node server.js", port: 3001, ready: { kind: "port" }, label: "API", primary: false, hostRewrite: true } as const;

const reserved: ReservedPorts = { "key-proxy": 41_001, "git-proxy": 41_002, "mcp-proxy": 41_003, "sidecar-control": 7101, "agent-loopback": 4096, browser: 9222 };

describe("the environment's app processes (F-140)", () => {
  it("F-140: takes a frontend and its API, with the folder kept inside its repo and the defaults filled in", () => {
    const parsed = appProcessListSchema.parse([web, { ...api, folder: "./api/" }]);
    expect(parsed[1]?.folder).toBe("api");
    expect(appProcessSchema.parse({ name: "docs", repoId, command: "npx serve", port: 4000, ready: { kind: "port" }, label: "Docs" })).toMatchObject({ folder: ".", primary: false, hostRewrite: true });
    // The rows keep the ready check in two columns, and come back as the spec's list in order.
    const rows = parsed.map((process, index) => appProcessToRow(process, index));
    expect(rows[0]).toMatchObject({ readyKind: "http", readyValue: "/" });
    expect(rows[1]).toMatchObject({ readyKind: "port", readyValue: null });
    expect(specAppProcesses([...rows].reverse()).map((process) => process.name)).toEqual(["web", "api"]);
    expect(readyCheckFromColumns({ readyKind: "http", readyValue: null })).toBeNull();
  });

  it("F-140: the rules, each with its near miss: one primary, names and ports once, no port below 1024, no port the box keeps, a folder in its repo", () => {
    const issues = (list: Parameters<typeof appProcessListIssues>[0]): readonly string[] => appProcessListIssues(list).map((issue) => issue.rule);
    // One primary; two is refused.
    expect(issues([web, api])).toEqual([]);
    expect(issues([web, { ...api, primary: true }])).toEqual(["one-primary"]);
    // Names once; a different name is fine.
    expect(issues([web, { ...api, name: "web" }])).toEqual(["unique-name"]);
    expect(issues([web, { ...api, name: "web-2" }])).toEqual([]);
    // Ports once; the next port is fine.
    expect(issues([web, { ...api, port: 5173 }])).toEqual(["unique-port"]);
    expect(issues([web, { ...api, port: 5174 }])).toEqual([]);
    // The box's own control port is refused; the one beside it isn't.
    expect(appProcessListIssues([{ ...api, port: 7101 }])).toEqual([{ rule: "reserved-port", port: 7101, name: "sidecar-control" }]);
    expect(issues([{ ...api, port: 7102 }])).toEqual([]);
    // A repo the project doesn't have.
    expect(appProcessListIssues([web], [otherRepoId]).map((issue) => issue.rule)).toEqual(["unknown-repo"]);
    expect(appProcessListIssues([web], [repoId])).toEqual([]);
    // Below 1024 is the port's own refusal; 1024 is the first allowed.
    expect(appProcessListSchema.safeParse([{ ...api, port: 1023 }]).success).toBe(false);
    expect(appProcessListSchema.safeParse([{ ...api, port: 1024 }]).success).toBe(true);
    // A folder that leaves its repo, or is absolute, is refused; a nested one isn't.
    for (const folder of ["../other", "api/../../x", "/etc", "C:/x"]) {
      expect(appProcessListSchema.safeParse([{ ...api, folder }]).success, folder).toBe(false);
    }
    expect(appProcessListSchema.safeParse([{ ...api, folder: "packages/api" }]).success).toBe(true);
    // The list's own refinements say the rule in words.
    const refused = appProcessListSchema.safeParse([web, { ...api, primary: true }]);
    expect(refused.success ? null : refused.error.issues[0]?.message).toBe("At most one app process is the primary preview.");
    expect(appProcessListSchema.safeParse(Array.from({ length: 11 }, (_, index) => ({ ...api, name: `p${String(index)}`, port: 3000 + index }))).success).toBe(false);
  });

  it("F-121, F-140: screenshots after each turn are on by default, act only with a primary, and take at most 5 routes and the two widths", () => {
    const defaults = screenshotSettingsSchema.parse({});
    expect(defaults).toEqual({ afterTurn: true, routes: ["/"], widths: ["desktop"] });
    expect(specScreenshots(defaults, [web, api]).afterTurn).toBe(true);
    expect(specScreenshots(defaults, [api]).afterTurn).toBe(false);
    expect(screenshotSettingsSchema.safeParse({ routes: ["/", "/a", "/b", "/c", "/d"] }).success).toBe(true);
    expect(screenshotSettingsSchema.safeParse({ routes: ["/", "/a", "/b", "/c", "/d", "/e"] }).success).toBe(false);
    expect(screenshotSettingsSchema.safeParse({ routes: ["//evil.example"] }).success).toBe(false);
    expect(screenshotSettingsSchema.safeParse({ widths: ["desktop", "phone"] }).success).toBe(true);
    expect(screenshotSettingsSchema.safeParse({ widths: ["desktop", "desktop"] }).success).toBe(false);
    expect(screenshotSettingsSchema.safeParse({ widths: ["tablet"] }).success).toBe(false);
  });

  it("F-140: each process gets the others' in-box addresses: services by name on docker, at localhost on kubernetes, none on host", () => {
    const processes = [web, api];
    const services = [{ name: "mailpit", port: 8025 }, { name: "redis-cache", port: 6379 }, { name: "worker", port: null }];
    expect(appAddresses(processes, services, "docker")).toEqual({
      OSTRA_APP_WEB_URL: "http://localhost:5173",
      OSTRA_APP_API_URL: "http://localhost:3001",
      OSTRA_SERVICE_MAILPIT_URL: "http://mailpit:8025",
      OSTRA_SERVICE_REDIS_CACHE_URL: "http://redis-cache:6379",
    });
    expect(appAddresses(processes, services, "kubernetes")).toEqual({
      OSTRA_APP_WEB_URL: "http://localhost:5173",
      OSTRA_APP_API_URL: "http://localhost:3001",
      OSTRA_SERVICE_MAILPIT_URL: "http://localhost:8025",
      OSTRA_SERVICE_REDIS_CACHE_URL: "http://localhost:6379",
    });
    expect(appAddresses(processes, services, "host")).toEqual({ OSTRA_APP_WEB_URL: "http://localhost:5173", OSTRA_APP_API_URL: "http://localhost:3001" });
  });
});

describe("detection's readers (F-112, F-140)", () => {
  // A command line that writes a marker if anything runs it.
  const marker = path.join(tmpdir(), `ostra-detect-marker-${randomUUID()}`);
  const writesMarker = `node -e "require('fs').writeFileSync('${marker.replace(/\\/g, "/")}', 'ran')"`;

  it("F-140: reads forwardPorts and portsAttributes, a label and openPreview as the primary's hint", () => {
    expect(readDevcontainerPorts({ forwardPorts: [3000, "db:5432", "x"], portsAttributes: { "4000": { label: "Docs", onAutoForward: "openPreview" }, nope: {} } })).toEqual([
      { port: 3000, label: null, preview: false },
      { port: 5432, label: null, preview: false },
      { port: 4000, label: "Docs", preview: true },
    ]);
    // A near miss: no forwardPorts and an attribute that isn't an object.
    expect(readDevcontainerPorts({ portsAttributes: { "3000": "web" } })).toEqual([]);
    expect(readDevcontainerPorts("not an object")).toEqual([]);
  });

  it("F-140: reads .gitpod.yml's ports and .replit's [[ports]], skipping a range", () => {
    const gitpod = ["tasks:", "  - init: pnpm install", "ports:", "  - port: 5173", "    name: Web", "    onOpen: open-preview", "  - port: 3000-3010", "  - name: API", "    port: 3001", "vscode:", "  extensions: []"].join("\n");
    expect(readGitpodPorts(gitpod)).toEqual([
      { port: 5173, label: "Web", preview: true },
      { port: 3001, label: "API", preview: false },
    ]);
    expect(readGitpodPorts("tasks:\n  - command: 'port: 1234'\n")).toEqual([]);
    const replit = ['run = "npm run dev"', "", "[[ports]]", "localPort = 5173", "externalPort = 80", "", "[[ports]]", "localPort = 3001", "", "[nix]", "localPort = 9999"].join("\n");
    expect(readReplitPorts(replit).map((port) => port.port)).toEqual([5173, 3001]);
  });

  it("F-140: reads package.json's dev and start scripts and a Vite config's server.port and server.proxy as text", () => {
    expect(readPackageScripts({ scripts: { dev: "vite", start: "next start -p 4000", test: "vitest" } })).toEqual([
      { script: "dev", tool: "vite", port: 5173 },
      { script: "start", tool: "next", port: 4000 },
    ]);
    expect(readPackageScripts({ scripts: { dev: "PORT=8080 node server.js" } })).toEqual([{ script: "dev", tool: null, port: 8080 }]);
    expect(readPackageScripts({ scripts: { build: "vite build" } })).toEqual([]);
    const config = [
      'import { defineConfig } from "vite";',
      "export default defineConfig({",
      "  plugins: [react()],",
      "  server: {",
      "    port: 5180,",
      "    proxy: {",
      "      '/api': 'http://localhost:3001',",
      '      "/ws": { target: "ws://127.0.0.1:3002", ws: true },',
      "    },",
      "  },",
      "  preview: { port: 4173 },",
      "});",
    ].join("\n");
    expect(readViteConfig(config)).toEqual({
      port: 5180,
      proxy: [
        { path: "/api", targetPort: 3001 },
        { path: "/ws", targetPort: 3002 },
      ],
    });
    expect(readViteConfig("export default { build: { outDir: 'dist' } }")).toEqual({ port: null, proxy: [] });
  });

  it("F-140/c7: reads a port a Vite config keeps in a variable from its declaration, and the other scripts that name their port", () => {
    // Ticket 15: the `test-web` fixture's form, every port movable by a variable with its default in the text.
    const config = [
      'const port = Number(process.env["TEST_WEB_PORT"] ?? "5174");',
      'const apiPort = process.env["TEST_WEB_API_PORT"] ?? "3011";',
      "const docs = 'http://localhost:4010';",
      "export default defineConfig({",
      "  server: {",
      "    port,",
      "    strictPort: true,",
      "    proxy: {",
      "      '/api': { target: `http://localhost:${apiPort}`, ws: true },",
      "      '/docs': { target: docs },",
      "      '/nowhere': { target: `http://localhost:${notDeclared}` },",
      "    },",
      "  },",
      "});",
    ].join("\n");
    expect(readViteConfig(config)).toEqual({
      port: 5174,
      proxy: [
        { path: "/api", targetPort: 3011 },
        { path: "/docs", targetPort: 4010 },
        { path: "/nowhere", targetPort: null },
      ],
    });
    // `port: webPort` reads the same; a port it can't find is left out.
    expect(readViteConfig("const webPort = 5175;\nexport default { server: { port: webPort } }").port).toBe(5175);
    expect(readViteConfig("export default { server: { port: process.env.PORT } }").port).toBeNull();
    // The other scripts that name their port serve something; one that builds or tests doesn't, whatever it names.
    expect(
      readPortScripts({ scripts: { dev: "vite", api: "node api/server.js --port 3001", "dev:docs": "PORT=4000 node docs.js", storybook: "storybook dev -p 6006", "test:e2e": "playwright test --port 9323", build: "vite build --port 1" } }),
    ).toEqual([
      { script: "api", port: 3001 },
      { script: "dev:docs", port: 4000 },
      { script: "storybook", port: 6006 },
    ]);
    expect(readPortScripts({ scripts: { lint: "eslint .", api: "node api/server.js" } })).toEqual([]);
    const detected = detectEnvironment({
      tree: null,
      files: new Map([
        ["package.json", JSON.stringify({ scripts: { dev: "vite", api: "node api/server.js --port 3011" } })],
        ["vite.config.js", config],
      ]),
    });
    // The proxy's API takes the script's command; one port is one process.
    expect(detected.appProcesses.map((process) => [process.name, process.port, process.command])).toEqual([
      ["web", 5174, "npm run dev"],
      ["api", 3011, "npm run api"],
      ["docs", 4010, null],
    ]);
  });

  it("F-140/c7: reads the default a port or proxy target falls back to when an env variable moves it, without evaluating the config", () => {
    // The forms real configs write: `??`, `||`, inside a template, through a variable, and the
    // `test-web` fixture's own, a fallback that names another variable with its env fallback.
    const config = [
      'const a = process.env.A_URL ?? "http://localhost:3101";',
      "const b = process.env['B_URL'] || 'http://127.0.0.1:3102';",
      'const c = `${process.env.C_URL ?? "http://localhost:3103"}`;',
      'const gPort = process.env["G_PORT"] ?? "3107";',
      'const g = process.env["G_URL"] ?? `http://localhost:${gPort}`;',
      // Prettier's wrap of a long one, and a file without semicolons.
      "const h =",
      "  process.env.H_URL ??",
      '  "http://localhost:3108";',
      'const i = process.env.I_URL ?? "http://localhost:3109"',
      'const j = process.env.J_URL ?? "http://localhost:3110"',
      // A loop between two names ends; neither gives a port.
      "const x = y;",
      "const y = x;",
      "export default defineConfig({",
      "  server: {",
      "    port: parseInt(process.env.PORT, 10) || 5190, // not the radix",
      "    proxy: {",
      "      '/a': { target: a, changeOrigin: true },",
      "      '/b': { target: b },",
      "      '/c': { target: c },",
      '      "/d": { target: process.env.D_URL ?? "http://localhost:3104", ws: true },',
      "      '/e': process.env.E_URL || 'http://localhost:3105',",
      '      \'/f\': `${process.env.F_URL ?? "http://localhost:3106"}`,',
      "      '/g': { target: g, rewrite: (path) => path.replace(/^\\/g/, '') },",
      "      '/h': { target: h },",
      "      '/i': { target: i },",
      "      '/j': { target: j },",
      "      '/k': { target: `http://localhost:${import.meta.env.K_PORT ?? 3111}/v1` },",
      "      '/unset': { target: process.env.UNSET_URL },",
      "      '/loop': { target: x },",
      "    },",
      "  },",
      "});",
    ].join("\n");
    expect(readViteConfig(config)).toEqual({
      port: 5190,
      proxy: [
        { path: "/a", targetPort: 3101 },
        { path: "/b", targetPort: 3102 },
        { path: "/c", targetPort: 3103 },
        { path: "/d", targetPort: 3104 },
        { path: "/e", targetPort: 3105 },
        { path: "/f", targetPort: 3106 },
        { path: "/g", targetPort: 3107 },
        { path: "/h", targetPort: 3108 },
        { path: "/i", targetPort: 3109 },
        { path: "/j", targetPort: 3110 },
        { path: "/k", targetPort: 3111 },
        { path: "/unset", targetPort: null },
        { path: "/loop", targetPort: null },
      ],
    });
    // A port an env variable moves, in each form.
    for (const expression of ['Number(process.env.PORT ?? "5191")', "Number(process.env.PORT) || 5191", '`${process.env.PORT ?? "5191"}`', "webPort"]) {
      expect(readViteConfig(`const webPort = process.env.WEB_PORT ?? 5191;\nexport default { server: { port: ${expression} } }`).port).toBe(5191);
    }
    // A target with no port of its own gives none, whatever number its path holds.
    expect(readViteConfig("export default { server: { proxy: { '/api': process.env.API_URL ?? 'https://api.example.com/2024' } } }").proxy).toEqual([{ path: "/api", targetPort: null }]);
  });

  it("F-140: proposes the frontend as the primary and its API behind the proxy, and runs nothing it reads", async () => {
    const files = new Map([
      ["package.json", JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { dev: `${writesMarker} && vite --port 5173`, start: writesMarker } })],
      ["pnpm-lock.yaml", ""],
      ["vite.config.ts", `${writesMarker.replace(/^node -e /, "")};\nexport default { server: { proxy: { '/api': 'http://localhost:3001' } } };`],
      [".devcontainer/devcontainer.json", JSON.stringify({ forwardPorts: [4000, 80], portsAttributes: { "4000": { label: "Docs" } }, postCreateCommand: writesMarker })],
      [".gitpod.yml", `tasks:\n  - command: ${writesMarker}\nports:\n  - port: 4000\n`],
      [".replit", `run = "${writesMarker.replace(/"/g, "'")}"\n[[ports]]\nlocalPort = 3001\n`],
    ]);
    const detected = detectEnvironment({ tree: [...files.keys()], files });
    expect(detected.appProcesses.map((process) => [process.name, process.port, process.primary, process.command])).toEqual([
      ["web", 5173, true, "pnpm dev"],
      ["api", 3001, false, null],
      ["docs", 4000, false, null],
    ]);
    // Port 80 isn't proposed: no preview reaches it.
    expect(detected.appProcesses.some((process) => process.port === 80)).toBe(false);
    expect(detected.reasons.some((reason) => reason.finding.includes("below 1024"))).toBe(true);
    // Nothing ran: the marker is still missing.
    await expect(access(marker)).rejects.toThrow();
  });

  it("F-140: a devcontainer's openPreview hint makes that port the primary, over the dev server", () => {
    const files = new Map([
      ["package.json", JSON.stringify({ scripts: { dev: "vite" } })],
      [".devcontainer.json", JSON.stringify({ forwardPorts: [3000], portsAttributes: { "3000": { label: "Storybook", onAutoForward: "openPreview" } } })],
    ]);
    const detected = detectEnvironment({ tree: null, files });
    expect(detected.appProcesses.filter((process) => process.primary).map((process) => process.name)).toEqual(["storybook"]);
    expect(detected.appProcesses.find((process) => process.name === "web")?.command).toBe("npm run dev");
  });
});

describe("a task's previews and what they reach (F-141)", () => {
  const environment = {
    processes: [
      { name: "api", port: 3001, label: "API", primary: false, position: 1 },
      { name: "web", port: 5173, label: "Web", primary: true, position: 0 },
    ],
    services: [
      { name: "mailpit", port: 8025, previewLabel: "Mail" },
      { name: "postgres", port: 5432, previewLabel: null },
    ],
    servicesRun: true,
  };

  it("F-141: lists the primary first, then the processes, the services marked as previews and the announced ports", () => {
    const targets = previewTargets(environment, [
      { port: 4100, label: "Docs", path: "/guide", primary: false },
      { port: 5173, label: "Again", path: "/", primary: false },
      { port: 4200, label: "Other", path: "/", primary: true },
    ]);
    expect(targets.map((target) => [target.key, target.primary, target.source])).toEqual([
      ["app-web", true, "declared"],
      ["app-api", false, "declared"],
      ["service-mailpit", false, "declared"],
      ["port-4100", false, "announced"],
      ["port-4200", false, "announced"],
    ]);
    // On host no service runs, so none is a preview.
    expect(previewTargets({ ...environment, servicesRun: false }, []).map((target) => target.key)).toEqual(["app-web", "app-api"]);
  });

  it("F-141: mayReach refuses every reserved port, a port below 1024 and one that isn't a preview, and takes a preview's", () => {
    const targets = previewTargets(environment, [{ port: 4100, label: "Docs", path: "/", primary: false }]);
    for (const name of reservedPortNames) {
      const port = reserved[name];
      if (port === null) {
        continue;
      }
      // Even when the list itself names the port, the box's own is refused.
      const listed = [...targets, { ...targets[0], key: previewKeySchema.parse(`port-${String(port)}`), target: { port }, port, label: "Sneaky", primary: false, path: "/", source: "announced" as const }];
      expect(mayReach(port, listed, reserved), name).toMatchObject({ ok: false, refusal: { reason: "reserved", name } });
    }
    // The fixed control port is refused even when the box's numbers don't name it.
    expect(mayReach(7101, targets, { ...reserved, "sidecar-control": null })).toMatchObject({ ok: false, refusal: { reason: "reserved" } });
    for (const port of [22, 80, 443, 1023]) {
      expect(mayReach(port, targets, reserved)).toEqual({ ok: false, refusal: { reason: "below-min" } });
    }
    expect(mayReach(6006, targets, reserved)).toEqual({ ok: false, refusal: { reason: "not-a-preview" } });
    expect(mayReach(5173, targets, reserved)).toEqual({ ok: true, target: { process: "web" }, key: webKey });
    expect(mayReach(4100, targets, reserved)).toMatchObject({ ok: true, target: { port: 4100 } });
  });

  it("F-141: warmHold holds a watched box to the cap and not past it, and never counts the app's own sockets", () => {
    const settings = { warmMinutes: 60 };
    const box = { previewWatchedAt: at - 30_000, lastTurnEndedAt: at - 10 * MINUTE, appStartedAt: null };
    expect(warmHold(box, at, settings)).toEqual({ hold: true, until: at + 50 * MINUTE });
    // Just inside the cap, and at it.
    const late = { ...box, lastTurnEndedAt: at - 60 * MINUTE + 1 };
    expect(warmHold(late, at, settings)).toMatchObject({ hold: true });
    expect(warmHold({ ...box, lastTurnEndedAt: at - 60 * MINUTE }, at, settings)).toEqual({ hold: false, reason: "past-the-cap" });
    // The later of the last turn and an app start counts.
    expect(warmHold({ ...box, lastTurnEndedAt: at - 90 * MINUTE, appStartedAt: at - 5 * MINUTE }, at, settings)).toMatchObject({ hold: true });
    // A heartbeat older than 2 minutes isn't watching.
    expect(warmHold({ ...box, previewWatchedAt: at - PREVIEW_WATCHED_WITHIN_MS - 1 }, at, settings)).toEqual({ hold: false, reason: "not-watched" });
    expect(warmHold({ ...box, previewWatchedAt: at - PREVIEW_WATCHED_WITHIN_MS }, at, settings)).toMatchObject({ hold: true });
    // The app's HMR socket a second ago, with no pane: not watched.
    expect(warmHold({ ...box, previewWatchedAt: null, lastAppTrafficAt: at - 1000 }, at, settings)).toEqual({ hold: false, reason: "not-watched" });
    expect(warmHold({ ...box, previewWatchedAt: at - 3 * MINUTE, lastAppTrafficAt: at }, at, settings)).toEqual({ hold: false, reason: "not-watched" });
    expect(warmHold({ previewWatchedAt: at, lastTurnEndedAt: null, appStartedAt: null }, at, settings)).toEqual({ hold: false, reason: "never-started" });
  });
});

describe("who may open a preview (F-142)", () => {
  const asked = { taskId, key: webKey };
  const link = (facts: Partial<PreviewLinkFacts> = {}): PreviewLinkFacts => ({
    linkId,
    taskId,
    key: webKey,
    kind: "expiring",
    allowInput: false,
    expiresAt: new Date(at + 60 * MINUTE),
    revokedAt: null,
    revokedByMemberId: null,
    ...facts,
  });
  const allowLinks = { publicPreviewLinks: true };
  const forbidLinks = { publicPreviewLinks: false };
  const named = { level: "named" as const, memberIds: [otherMemberId] };

  it("F-142: a member who can open the task may, with input; one who can't may not, by default and at every level but named", () => {
    expect(previewAccess({ kind: "member", memberId, canOpenTask: true }, asked, null, forbidLinks, at)).toEqual({ allowed: true, input: true, as: "member" });
    const outsider = { kind: "member" as const, memberId, canOpenTask: false };
    // None allowed by default: no row is the project's members only.
    expect(previewAccess(outsider, asked, null, allowLinks, at)).toEqual({ allowed: false, reason: "not-allowed" });
    expect(previewAccess(outsider, asked, { level: "members", memberIds: [memberId] }, allowLinks, at)).toEqual({ allowed: false, reason: "not-allowed" });
    expect(previewAccess(outsider, asked, named, allowLinks, at)).toEqual({ allowed: false, reason: "not-allowed" });
  });

  it("F-142: a named person sees that preview, watch-only, and nothing else", () => {
    const person = { kind: "member" as const, memberId: otherMemberId, canOpenTask: false };
    expect(previewAccess(person, asked, named, forbidLinks, at)).toEqual({ allowed: true, input: false, as: "named" });
    // The level is per preview: the row the caller reads is that preview's.
    expect(previewAccess(person, asked, { level: "members", memberIds: [] }, forbidLinks, at)).toEqual({ allowed: false, reason: "not-allowed" });
  });

  it("F-142: a link opens its preview until it expires or is revoked, watch-only unless it allows input, public only where allowed", () => {
    expect(previewAccess({ kind: "link", link: link() }, asked, null, forbidLinks, at)).toEqual({ allowed: true, input: false, as: "link" });
    expect(previewAccess({ kind: "link", link: link({ allowInput: true }) }, asked, null, forbidLinks, at)).toEqual({ allowed: true, input: true, as: "link" });
    const expired = previewAccess({ kind: "link", link: link({ expiresAt: new Date(at) }) }, asked, null, allowLinks, at);
    expect(expired).toEqual({ allowed: false, reason: "link-expired" });
    const revoked = previewAccess({ kind: "link", link: link({ revokedAt: new Date(at - MINUTE), revokedByMemberId: memberId }) }, asked, null, allowLinks, at);
    expect(revoked).toEqual({ allowed: false, reason: "link-revoked" });
    const publicLink = link({ kind: "public", expiresAt: null });
    expect(previewAccess({ kind: "link", link: publicLink }, asked, null, forbidLinks, at)).toEqual({ allowed: false, reason: "public-links-off" });
    expect(previewAccess({ kind: "link", link: publicLink }, asked, null, allowLinks, at)).toEqual({ allowed: true, input: false, as: "link" });
    // Failing closed: a link for another preview or task, or an expiring link with no end.
    expect(previewAccess({ kind: "link", link: link({ key: previewKeySchema.parse("app-api") }) }, asked, null, allowLinks, at)).toEqual({ allowed: false, reason: "link-unknown" });
    expect(previewAccess({ kind: "link", link: link({ taskId: taskIdSchema.parse(randomUUID()) }) }, asked, null, allowLinks, at)).toEqual({ allowed: false, reason: "link-unknown" });
    expect(previewAccess({ kind: "link", link: link({ expiresAt: null }) }, asked, null, allowLinks, at)).toEqual({ allowed: false, reason: "link-expired" });
    for (const reason of ["not-allowed", "link-expired", "link-revoked", "public-links-off", "link-unknown", "level-unknown"] as const satisfies readonly PreviewAccessRefusal[]) {
      expect(previewAccessWords(reason).length, reason).toBeGreaterThan(10);
    }
    expect(previewLevelChoices(forbidLinks)).not.toContain("public");
    expect(previewLevelChoices(allowLinks)).toContain("public");
  });
});

describe("the native preview's hosts and rewrites (F-144)", () => {
  const domain = "preview.localhost";
  const host = previewHost(5173, previewId, domain);
  const own = `https://${host}`;
  const panelOrigin = "https://ostra.example.com";

  it("F-144: a preview host names a port and a preview ID to look up, and parsePreviewHost refuses a malformed or too-long label", () => {
    expect(host).toBe("5173-abcdefghijklmnopqrstuvwx23.preview.localhost");
    expect(parsePreviewHost(host, domain)).toEqual({ port: 5173, previewId });
    expect(parsePreviewHost(`${host.toUpperCase()}:443`, domain)).toEqual({ port: 5173, previewId });
    expect(parsePreviewHost(`${host}.`, "preview.localhost.")).toEqual({ port: 5173, previewId });
    for (const bad of [
      "preview.localhost",
      "evil.example",
      `5173-${previewId}.preview.localhost.evil.example`,
      `a.5173-${previewId}.preview.localhost`,
      `80-${previewId}.preview.localhost`,
      `99999-${previewId}.preview.localhost`,
      `5173-${previewId}x.preview.localhost`,
      "5173-ABCDEFGHIJKLMNOPQRSTUVWX01.preview.localhost",
      `5173_${previewId}.preview.localhost`,
      `${"1".repeat(64)}.preview.localhost`,
      `${"a.".repeat(130)}preview.localhost`,
      `5173-${previewId}.notpreview.localhost`,
    ]) {
      expect(parsePreviewHost(bad, domain), bad).toBeNull();
    }
  });

  const request = {
    host,
    origin: own,
    cookie: `theme=dark; ${PREVIEW_COOKIE}=secret-session; sid=app`,
    "x-forwarded-host": "evil.example",
    "x-forwarded-for": "10.0.0.1",
    forwarded: "for=10.0.0.1;host=evil.example",
    "x-ostra-member": "mem-1",
    accept: "text/html",
  };

  it("F-144: with hostRewrite on, Host and Origin become localhost, the preview's cookie and a client's X-Forwarded-* go", () => {
    const out = rewriteRequest(request, { port: 5173, previewHost: host, hostRewrite: true, outsideLink: false });
    expect(out).toEqual({ ok: true, headers: { host: "localhost:5173", origin: "http://localhost:5173", cookie: "theme=dark; sid=app", accept: "text/html" } });
    // A cookie header holding only ours goes whole.
    const onlyOurs = rewriteRequest({ host, cookie: `${PREVIEW_COOKIE}=x` }, { port: 5173, previewHost: host, hostRewrite: true, outsideLink: false });
    expect(onlyOurs.ok && "cookie" in onlyOurs.headers).toBe(false);
  });

  it("F-144: with hostRewrite off, the app gets the real host, X-Forwarded-Host and the proto, never the client's", () => {
    const out = rewriteRequest(request, { port: 5173, previewHost: host, hostRewrite: false, outsideLink: false });
    expect(out).toEqual({
      ok: true,
      headers: { host, "x-forwarded-host": host, "x-forwarded-proto": "https", origin: own, cookie: "theme=dark; sid=app", accept: "text/html" },
    });
  });

  it("F-144: a WebSocket upgrade must come from the preview's own origin, and an outside link's keeps the browser's Origin", () => {
    const upgrade = { host, origin: own, upgrade: "websocket", connection: "Upgrade" };
    expect(rewriteRequest({ ...upgrade, origin: "https://evil.example" }, { port: 5173, previewHost: host, hostRewrite: true, outsideLink: false })).toEqual({ ok: false, reason: "bad-origin" });
    expect(rewriteRequest({ host, upgrade: "websocket" }, { port: 5173, previewHost: host, hostRewrite: true, outsideLink: false })).toEqual({ ok: false, reason: "bad-origin" });
    const member = rewriteRequest(upgrade, { port: 5173, previewHost: host, hostRewrite: true, outsideLink: false });
    expect(member.ok && member.headers["origin"]).toBe("http://localhost:5173");
    const outside = rewriteRequest(upgrade, { port: 5173, previewHost: host, hostRewrite: true, outsideLink: true });
    expect(outside.ok && outside.headers["origin"]).toBe(own);
    expect(outside.ok && outside.headers["host"]).toBe("localhost:5173");
  });

  it("F-144: the framing headers are replaced by the panel's origin, and Location goes back to the preview's host", () => {
    const out = rewriteResponse(
      { "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; frame-ancestors 'none'; img-src *", location: "http://localhost:5173/login?next=/", "set-cookie": ["a=1", "b=2"] },
      { panelOrigin, previewHost: host, port: 5173 },
    );
    expect(out).toEqual({
      framingReplaced: true,
      headers: {
        "content-security-policy": `default-src 'self'; img-src *; frame-ancestors ${panelOrigin}`,
        location: `https://${host}/login?next=/`,
        "set-cookie": ["a=1", "b=2"],
      },
    });
    // With no framing header, the panel's origin is still the only one that may frame it.
    expect(rewriteResponse({ "content-type": "text/html" }, { panelOrigin, previewHost: host, port: 5173 })).toEqual({
      framingReplaced: false,
      headers: { "content-type": "text/html", "content-security-policy": `frame-ancestors ${panelOrigin}` },
    });
    // A Location on another port or host is the app's business, left as it is.
    const away = rewriteResponse({ location: "http://localhost:3001/x" }, { panelOrigin, previewHost: host, port: 5173 });
    expect(away.headers["location"]).toBe("http://localhost:3001/x");
  });
});

describe("the previews' tokens (F-142, F-143, F-144)", () => {
  const fixed = (byte: number) => (size: number): Uint8Array => new Uint8Array(size).fill(byte);

  it("F-142: a link's token is 32 random bytes, kept as a SHA-256 and compared in constant time", () => {
    const { token, tokenHash } = newPreviewLinkToken(fixed(7));
    expect(token).toMatch(/^ostra-preview-[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(token.slice(14));
    expect(previewLinkTokenMatches(token, tokenHash)).toBe(true);
    expect(previewLinkTokenMatches(newPreviewLinkToken(fixed(8)).token, tokenHash)).toBe(false);
    expect(previewLinkTokenMatches(`${token}x`, tokenHash)).toBe(false);
    expect(previewLinkTokenHash("not a token")).toBeNull();
    expect(newPreviewLinkToken().token).not.toBe(newPreviewLinkToken().token);
  });

  it("F-143, F-144: a code and a ticket work once, for 60 s, bound to the viewer, the task, the port and the lease epoch", () => {
    const binding = { kind: "enter" as const, taskId, key: webKey, port: 5173, leaseEpoch: 3, viewer: { kind: "link" as const, linkId } };
    const issued = issuePreviewCode(binding, at, fixed(1));
    if (!issued.ok) {
      throw new Error("issued");
    }
    expect(issued.code).toMatch(/^ostra-code-/);
    expect(issued.row).toMatchObject({ kind: "enter", memberId: null, linkId, leaseEpoch: 3, usedAt: null });
    expect(issued.row.expiresAt.getTime()).toBe(at + PREVIEW_CODE_TTL_MS);
    const expect5173 = { kind: "enter" as const, leaseEpoch: 3, now: at + 1000, taskId, port: 5173 };
    expect(checkPreviewCode(issued.code, issued.row, expect5173)).toEqual({ ok: true, viewer: { kind: "link", linkId }, taskId, key: webKey, port: 5173 });
    // Once: a used row is refused.
    expect(checkPreviewCode(issued.code, { ...issued.row, usedAt: new Date(at) }, expect5173)).toEqual({ ok: false, reason: "used" });
    // 60 s: at its deadline it's gone.
    expect(checkPreviewCode(issued.code, issued.row, { ...expect5173, now: at + PREVIEW_CODE_TTL_MS })).toEqual({ ok: false, reason: "expired" });
    // Bound: another port, task, kind or lease epoch is refused.
    expect(checkPreviewCode(issued.code, issued.row, { ...expect5173, port: 3001 })).toEqual({ ok: false, reason: "wrong-binding" });
    expect(checkPreviewCode(issued.code, issued.row, { ...expect5173, taskId: taskIdSchema.parse(randomUUID()) })).toEqual({ ok: false, reason: "wrong-binding" });
    expect(checkPreviewCode(issued.code, issued.row, { ...expect5173, kind: "cli_ticket" })).toEqual({ ok: false, reason: "wrong-kind" });
    expect(checkPreviewCode(issued.code, issued.row, { ...expect5173, leaseEpoch: 4 })).toEqual({ ok: false, reason: "stale-lease" });
    // Another code against this row, or none at all.
    const other = issuePreviewCode(binding, at, fixed(2));
    expect(other.ok && checkPreviewCode(other.code, issued.row, expect5173)).toEqual({ ok: false, reason: "unknown" });
    expect(checkPreviewCode(issued.code, null, expect5173)).toEqual({ ok: false, reason: "unknown" });
    // A CLI ticket is a member's only, never a link's.
    expect(issuePreviewCode({ ...binding, kind: "cli_ticket" }, at, fixed(3))).toEqual({ ok: false, reason: "ticket-for-a-link" });
    const ticket = issuePreviewCode({ ...binding, kind: "cli_ticket", viewer: { kind: "member", memberId } }, at, fixed(3));
    expect(ticket.ok && ticket.code).toMatch(/^ostra_pt_[A-Za-z0-9_-]{43}$/);
    expect(ticket.ok && checkPreviewCode(ticket.code, ticket.row, { kind: "cli_ticket", leaseEpoch: 3, now: at })).toMatchObject({ ok: true, viewer: { kind: "member", memberId } });
  });

  it("F-141: the panel's token opens one view, for one member or link, for a minute, and nothing forged or past it", () => {
    const tokens = createPanelPreviewTokens("a".repeat(44));
    const organizationId = organizationIdSchema.parse(randomUUID());
    const claims = { organizationId, viewId, viewer: { kind: "member" as const, memberId }, expiresAt: at + 60_000 };
    const token = tokens.issue(claims);
    expect(token).toMatch(/^ostra-view-/);
    expect(tokens.verify(token, at, viewId)).toEqual(claims);
    expect(tokens.verify(token, at + 60_000, viewId)).toBeNull();
    expect(tokens.verify(token, at, previewViewIdSchema.parse(randomUUID()))).toBeNull();
    expect(createPanelPreviewTokens("b".repeat(44)).verify(token, at, viewId)).toBeNull();
    expect(tokens.verify(tamperToken(token), at, viewId)).toBeNull();
    // A deadline more than a minute ahead isn't one this build makes.
    expect(tokens.verify(tokens.issue({ ...claims, expiresAt: at + 10 * MINUTE }), at, viewId)).toBeNull();
    const byLink = tokens.issue({ ...claims, viewer: { kind: "link", linkId } });
    expect(tokens.verify(byLink, at, viewId)?.viewer).toEqual({ kind: "link", linkId });
  });

  it("F-141: a replica's forwarded request is signed over its method, path, view and time, and refused after 30 s or altered", () => {
    const secret = "s".repeat(44);
    const request = { method: "GET", path: `/panel/v1/previews/${viewId}/stream`, viewId };
    const signature = signReplicaRequest(secret, { ...request, at });
    expect(verifyReplicaRequest(secret, request, signature, at + 1000)).toBe(true);
    expect(verifyReplicaRequest(secret, request, signature, at + REPLICA_SIGNATURE_MAX_AGE_MS)).toBe(true);
    expect(verifyReplicaRequest(secret, request, signature, at + REPLICA_SIGNATURE_MAX_AGE_MS + 1)).toBe(false);
    expect(verifyReplicaRequest(secret, request, signature, at - REPLICA_SIGNATURE_MAX_AGE_MS - 1)).toBe(false);
    expect(verifyReplicaRequest(secret, { ...request, method: "POST" }, signature, at)).toBe(false);
    expect(verifyReplicaRequest(secret, { ...request, path: `${request.path}?x=1` }, signature, at)).toBe(false);
    expect(verifyReplicaRequest(secret, { ...request, viewId: previewViewIdSchema.parse(randomUUID()) }, signature, at)).toBe(false);
    expect(verifyReplicaRequest("t".repeat(44), request, signature, at)).toBe(false);
    expect(verifyReplicaRequest(secret, request, "", at)).toBe(false);
  });

  it("F-142, F-143, F-144: no token, code, ticket or panel token reaches a log line: the log guard redacts each", () => {
    const records: LogRecord[] = [];
    const logger = createLogger((record) => records.push(record));
    const link = newPreviewLinkToken().token;
    const code = issuePreviewCode({ kind: "enter", taskId, key: webKey, port: 5173, leaseEpoch: 1, viewer: { kind: "member", memberId } }, at);
    const ticket = issuePreviewCode({ kind: "cli_ticket", taskId, key: webKey, port: 5173, leaseEpoch: 1, viewer: { kind: "member", memberId } }, at);
    const view = createPanelPreviewTokens("a".repeat(44)).issue({ organizationId: organizationIdSchema.parse(randomUUID()), viewId, viewer: { kind: "member", memberId }, expiresAt: at + 1000 });
    const secrets = [link, code.ok ? code.code : "", ticket.ok ? ticket.code : "", view];
    for (const secret of secrets) {
      expect(secret.length).toBeGreaterThan(20);
      logger.info(`opened with ${secret}`, { token: secret, list: [secret], url: `https://x.example/?t=${secret}` });
    }
    const text = JSON.stringify(records);
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("[redacted]");
  });
});

describe("milestone 8's preview lifecycles", () => {
  it("F-140: an app process starts, gets ready or fails, exits or stops, and starts again after it ended", () => {
    const stopped: AppProcessLifecycle = { state: "stopped" };
    const starting: AppProcessLifecycle = { state: "starting", since: at };
    const ready: AppProcessLifecycle = { state: "ready", since: at };
    const exited: AppProcessLifecycle = { state: "exited", exitCode: 1, at };
    const failed: AppProcessLifecycle = { state: "failed", reason: "ready-timeout", exitCode: null, at };
    const inputs: readonly AppProcessInput[] = [
      { type: "start", at },
      { type: "ready", at },
      { type: "fail", reason: "ready-timeout", exitCode: null, at },
      { type: "exit", exitCode: 1, at },
      { type: "stop" },
    ];
    // Every state against every input: what the diagram draws moves, the rest is refused.
    const table: Record<AppProcessLifecycle["state"], readonly AppProcessInput["type"][]> = {
      stopped: ["start"],
      starting: ["ready", "fail", "stop"],
      ready: ["exit", "stop"],
      exited: ["start"],
      failed: ["start"],
    };
    for (const state of [stopped, starting, ready, exited, failed]) {
      for (const input of inputs) {
        expect(transitionAppProcess(state, input).ok, `${state.state} + ${input.type}`).toBe(table[state.state].includes(input.type));
      }
    }
    expect(transitionAppProcess(starting, { type: "fail", reason: "exited", exitCode: 2, at })).toEqual({ ok: true, state: { state: "failed", reason: "exited", exitCode: 2, at } });
    expect(transitionAppProcess(ready, { type: "stop" })).toEqual({ ok: true, state: stopped });
  });

  it("F-141: a view opens, is held by heartbeats, and closes once", () => {
    const opening: PreviewViewLifecycle = { state: "opening", since: at };
    const open: PreviewViewLifecycle = { state: "open", since: at, lastHeartbeatAt: at };
    const closed: PreviewViewLifecycle = { state: "closed", at, reason: "closed" };
    const inputs: readonly PreviewViewInput[] = [{ type: "connected", at }, { type: "heartbeat", at: at + 30_000 }, { type: "close", at, reason: "no-heartbeat" }];
    const table: Record<PreviewViewLifecycle["state"], readonly PreviewViewInput["type"][]> = { opening: ["connected", "close"], open: ["heartbeat", "close"], closed: [] };
    for (const state of [opening, open, closed]) {
      for (const input of inputs) {
        expect(transitionPreviewView(state, input).ok, `${state.state} + ${input.type}`).toBe(table[state.state].includes(input.type));
      }
    }
    expect(transitionPreviewView(open, { type: "heartbeat", at: at + 30_000 })).toEqual({ ok: true, state: { ...open, lastHeartbeatAt: at + 30_000 } });
    // A late heartbeat never moves the time back.
    expect(transitionPreviewView({ ...open, lastHeartbeatAt: at + 60_000 }, { type: "heartbeat", at: at + 30_000 })).toEqual({ ok: true, state: { ...open, lastHeartbeatAt: at + 60_000 } });
  });

  it("F-142: a link is active until it expires or is revoked, both for good, and a public one never expires", () => {
    const active: PreviewLinkLifecycle = { state: "active", expiresAt: at };
    const inputs: readonly PreviewLinkInput[] = [{ type: "expire", at }, { type: "revoke", at, byMemberId: memberId }];
    expect(transitionPreviewLink(active, { type: "expire", at })).toEqual({ ok: true, state: { state: "expired", at } });
    expect(transitionPreviewLink(active, { type: "expire", at: at - 1 }).ok).toBe(false);
    expect(transitionPreviewLink({ state: "active", expiresAt: null }, { type: "expire", at: at + 365 * 24 * 60 * MINUTE }).ok).toBe(false);
    expect(transitionPreviewLink(active, { type: "revoke", at, byMemberId: memberId })).toEqual({ ok: true, state: { state: "revoked", at, byMemberId: memberId } });
    for (const done of [{ state: "expired", at }, { state: "revoked", at, byMemberId: memberId }] as const satisfies readonly PreviewLinkLifecycle[]) {
      for (const input of inputs) {
        expect(transitionPreviewLink(done, input).ok).toBe(false);
      }
    }
    expect(previewLinkFromRow({ expiresAt: new Date(at), revokedAt: new Date(at - 1), revokedByMemberId: memberId }, at)).toMatchObject({ state: "revoked" });
    expect(previewLinkFromRow({ expiresAt: new Date(at), revokedAt: null, revokedByMemberId: null }, at)).toEqual({ state: "expired", at });
    expect(previewLinkFromRow({ expiresAt: null, revokedAt: null, revokedByMemberId: null }, at)).toEqual({ state: "active", expiresAt: null });
  });

  it("F-141: an app lease becomes a turn's at a member's message, and a turn's stays as it is", () => {
    expect(transitionLeasePurpose({ purpose: "app", startedByMemberId: memberId, at }, { type: "message", at })).toEqual({ ok: true, state: { purpose: "turn" } });
    expect(transitionLeasePurpose({ purpose: "turn" }, { type: "message", at }).ok).toBe(false);
  });
});

describe("milestone 8's preview jobs, audit actions and settings", () => {
  it("names the two sweeps, IDs only, each a schedule with its key", () => {
    expect(jobNames).toContain("preview.views-sweep");
    expect(jobNames).toContain("preview.codes-sweep");
    expect(jobSending["preview.views-sweep"]).toEqual({ kind: "schedule" });
    expect(jobSending["preview.codes-sweep"]).toEqual({ kind: "schedule" });
    expect(jobKey("preview.views-sweep", {})).toBe("previews:views-sweep");
    expect(jobKey("preview.codes-sweep", {})).toBe("previews:codes-sweep");
    expect(parseJobPayload("preview.views-sweep", {}).ok).toBe(true);
    expect(parseJobPayload("preview.codes-sweep", { code: "ostra-code-x" }).ok).toBe(false);
  });

  it("F-142: audits a start of the app, a level, a link made, revoked and first used, each about its task", () => {
    for (const action of ["app.started", "preview.level_changed", "preview.link_created", "preview.link_revoked", "preview.link_first_used"] as const) {
      expect(auditActions[action]).toBe("task");
    }
  });

  it("F-141, F-144: every preview setting has its working default with only the required settings set, and the domain is optional", () => {
    const parsed = parseServerSettings({});
    expect(parsed.ok && parsed.settings.previews).toEqual({ domain: null, warmMinutes: 60, linkMaxDays: 7, replicaUrl: null });
    const set = parseServerSettings({ OSTRA_PREVIEW_DOMAIN: "Previews.Example.com.", OSTRA_PREVIEW_WARM_MINUTES: "30", OSTRA_CORE_REPLICA_URL: "http://10.0.0.7:8787" });
    expect(set.ok && set.settings.previews).toEqual({ domain: "previews.example.com", warmMinutes: 30, linkMaxDays: 7, replicaUrl: "http://10.0.0.7:8787" });
    expect(parseServerSettings({ OSTRA_PREVIEW_DOMAIN: "preview.localhost" }).ok).toBe(true);
    for (const bad of ["https://previews.example.com", "*.previews.example.com", "previews.example.com:443", "localhost", "a_b.example.com"]) {
      expect(parseServerSettings({ OSTRA_PREVIEW_DOMAIN: bad }).ok, bad).toBe(false);
    }
    // The panel's own host under the preview domain is refused; a sibling isn't.
    expect(parseServerSettings({ OSTRA_PUBLIC_URL: "https://app.previews.example.com", OSTRA_PREVIEW_DOMAIN: "previews.example.com" }).ok).toBe(false);
    expect(parseServerSettings({ OSTRA_PUBLIC_URL: "https://ostra.example.com", OSTRA_PREVIEW_DOMAIN: "previews.example.com" }).ok).toBe(true);
    expect(parseServerSettings({ OSTRA_PREVIEW_LINK_MAX_DAYS: "0" }).ok).toBe(false);
  });
});
