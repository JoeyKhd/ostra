// Detecting an app's processes (milestone 8, F-112, F-140, ADR 0068): readers for the files that
// say how a repo's app runs, and the processes they suggest. Every reader takes the file's text and
// reads it as text: nothing here runs a script, loads a config or evaluates a line, so a file whose
// command would write a marker if run leaves none. A proposal is a draft for a project admin, who
// fills in what detection can't know.

/** The files the app's processes are read from, besides `package.json` and the devcontainer, which detection reads already. */
export const appContentPaths = [".gitpod.yml", ".replit", "vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"] as const;

/** A port a file names, with what it says about it. */
export type DetectedPort = {
  readonly port: number;
  /** The label the file gives it, or `null`. */
  readonly label: string | null;
  /** The file says to open it as a preview (`onAutoForward: openPreview`, `onOpen: open-preview`). */
  readonly preview: boolean;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A whole port, 1 to 65535, from a number or a string of digits. */
const portOf = (value: unknown): number | null => {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d{1,5}$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  return Number.isInteger(number) && number >= 1 && number <= 65_535 ? number : null;
};

const cleanLabel = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  let label = "";
  for (const character of value.trim()) {
    if ((character.codePointAt(0) ?? 0) >= 0x20) {
      label += character;
    }
  }
  label = label.slice(0, 60);
  return label === "" ? null : label;
};

/**
 * A devcontainer's `forwardPorts` (numbers, or `"host:port"` strings, whose port is taken) and its
 * `portsAttributes` (a port's `label`, and `onAutoForward: openPreview` as the primary's hint).
 * Takes the parsed JSON, which detection already reads with comments.
 */
export const readDevcontainerPorts = (parsed: unknown): readonly DetectedPort[] => {
  if (!isRecord(parsed)) {
    return [];
  }
  const attributes = isRecord(parsed["portsAttributes"]) ? parsed["portsAttributes"] : {};
  const ports = new Map<number, DetectedPort>();
  const forward = Array.isArray(parsed["forwardPorts"]) ? parsed["forwardPorts"] : [];
  for (const entry of forward) {
    const port = portOf(typeof entry === "string" ? entry.split(":").at(-1) : entry);
    if (port !== null) {
      ports.set(port, { port, label: null, preview: false });
    }
  }
  for (const [key, value] of Object.entries(attributes)) {
    const port = portOf(key);
    if (port === null || !isRecord(value)) {
      continue;
    }
    ports.set(port, { port, label: cleanLabel(value["label"]), preview: value["onAutoForward"] === "openPreview" });
  }
  return [...ports.values()];
};

/** The YAML scalar after `key:` on a line, unquoted, or `null`. */
const yamlValue = (line: string, key: string): string | null => {
  const found = new RegExp(`^\\s*-?\\s*${key}\\s*:\\s*(.*?)\\s*(?:#.*)?$`).exec(line);
  if (found === null) {
    return null;
  }
  const raw = found[1] ?? "";
  return raw.replace(/^(["'])(.*)\1$/, "$2");
};

/**
 * `.gitpod.yml`'s `ports:` list: each entry's `port`, its `name` and `onOpen: open-preview` as the
 * primary's hint. Read line by line: a port range (`3000-3010`) is skipped.
 */
export const readGitpodPorts = (text: string): readonly DetectedPort[] => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^ports\s*:\s*(?:#.*)?$/.test(line));
  if (start === -1) {
    return [];
  }
  const ports: DetectedPort[] = [];
  let current: { port: number | null; label: string | null; preview: boolean } | null = null;
  const flush = (): void => {
    if (current?.port !== null && current !== null) {
      ports.push({ port: current.port, label: current.label, preview: current.preview });
    }
    current = null;
  };
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) {
      break;
    }
    if (/^\s*-\s/.test(line)) {
      flush();
      current = { port: null, label: null, preview: false };
    }
    if (current === null) {
      continue;
    }
    const port = yamlValue(line, "port");
    if (port !== null) {
      current.port = portOf(port);
    }
    const name = yamlValue(line, "name");
    if (name !== null) {
      current.label = cleanLabel(name);
    }
    if (yamlValue(line, "onOpen") === "open-preview") {
      current.preview = true;
    }
  }
  flush();
  return ports;
};

/** `.replit`'s `[[ports]]` tables: each `localPort`, read as TOML text. */
export const readReplitPorts = (text: string): readonly DetectedPort[] => {
  const ports: DetectedPort[] = [];
  let inPorts = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inPorts = trimmed === "[[ports]]";
      continue;
    }
    const found = /^localPort\s*=\s*(\d{1,5})\s*(?:#.*)?$/.exec(trimmed);
    if (inPorts && found !== null) {
      const port = portOf(found[1]);
      if (port !== null) {
        ports.push({ port, label: null, preview: false });
      }
    }
  }
  return ports;
};

/** The dev servers whose default port detection knows, by the tool a script runs. */
const toolPorts: readonly { readonly tool: string; readonly pattern: RegExp; readonly port: number }[] = [
  { tool: "vite", pattern: /(?:^|[\s;&|])vite(?:\s+(?:dev|serve))?(?=\s|$)/, port: 5173 },
  { tool: "next", pattern: /(?:^|[\s;&|])next\s+(?:dev|start)\b/, port: 3000 },
  { tool: "astro", pattern: /(?:^|[\s;&|])astro\s+dev\b/, port: 4321 },
  { tool: "nuxt", pattern: /(?:^|[\s;&|])nuxi?\s+dev\b/, port: 3000 },
  { tool: "react-scripts", pattern: /(?:^|[\s;&|])react-scripts\s+start\b/, port: 3000 },
  { tool: "remix", pattern: /(?:^|[\s;&|])remix\s+(?:vite:)?dev\b/, port: 5173 },
];

/** A `package.json` script that starts the app: its name, the tool it runs, and the port it names or the tool's default. */
export type DetectedScript = {
  readonly script: "dev" | "start";
  readonly tool: string | null;
  readonly port: number | null;
};

/**
 * `package.json`'s `dev` and `start` scripts: the tool each runs (Vite, Next.js, Astro, Nuxt,
 * Create React App, Remix) and the port it names (`--port 4000`, `-p 4000`, `PORT=4000`), else the
 * tool's default. The script's text is data: it's matched, never run.
 */
export const readPackageScripts = (parsed: unknown): readonly DetectedScript[] => {
  if (!isRecord(parsed) || !isRecord(parsed["scripts"])) {
    return [];
  }
  const scripts = parsed["scripts"];
  const found: DetectedScript[] = [];
  for (const script of ["dev", "start"] as const) {
    const text = scripts[script];
    if (typeof text !== "string" || text.trim() === "") {
      continue;
    }
    const tool = toolPorts.find((entry) => entry.pattern.test(text)) ?? null;
    const named = /(?:--port[=\s]+|(?:^|\s)-p\s+|(?:^|[\s;&])PORT=)(\d{2,5})\b/.exec(text)?.[1];
    found.push({ script, tool: tool?.tool ?? null, port: portOf(named) ?? tool?.port ?? null });
  }
  return found;
};

/** Another `package.json` script that names the port it serves on: an API, a docs site, Storybook. */
export type DetectedPortScript = { readonly script: string; readonly port: number };

/** The scripts that build, test or check something: never a process, whatever port they name. */
const ONE_SHOT_SCRIPT = /^(?:pre|post)?(?:build|test|lint|format|typecheck|check|e2e|clean|install|prepare|release|deploy)(?:$|[:.-])/;

/**
 * `package.json`'s other scripts that name their port (`--port 4000`, `-p 4000`, `PORT=4000`),
 * beside `dev` and `start`: each one a process that serves, such as `"docs": "node docs/server.js
 * --port 4000"`. A script that builds, tests or checks is left out. Matched as text, never run.
 */
export const readPortScripts = (parsed: unknown): readonly DetectedPortScript[] => {
  if (!isRecord(parsed) || !isRecord(parsed["scripts"])) {
    return [];
  }
  const found: DetectedPortScript[] = [];
  for (const [script, text] of Object.entries(parsed["scripts"])) {
    if (script === "dev" || script === "start" || typeof text !== "string" || ONE_SHOT_SCRIPT.test(script)) {
      continue;
    }
    const port = portOf(/(?:--port[=\s]+|(?:^|\s)-p\s+|(?:^|[\s;&])PORT=)(\d{2,5})\b/.exec(text)?.[1]);
    if (port !== null) {
      found.push({ script, port });
    }
  }
  return found;
};

/** A Vite config's `server.port` and the paths and targets of its `server.proxy`. */
export type DetectedViteConfig = {
  readonly port: number | null;
  readonly proxy: readonly { readonly path: string; readonly targetPort: number | null }[];
};

/** The text of the `{ … }` block that starts at `open`, balanced by braces, or `null` when it never closes. */
const blockAt = (text: string, open: number): string | null => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open + 1, index);
      }
    }
  }
  return null;
};

/** The block after `key:` in `text`, or `null`. */
const blockOf = (text: string, key: string): string | null => {
  const found = new RegExp(`(?:^|[\\s,{])${key}\\s*:\\s*\\{`).exec(text);
  return found === null ? null : blockAt(text, found.index + found[0].length - 1);
};

/** A name a config may declare a port under: plain letters, digits and underscores. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The expression that starts at `start`, as text: up to the first `,` or `;` outside brackets and
 * quotes, a closing bracket it didn't open, or its line's end, unless the line ends with `??` or
 * `||` or the next starts with one, as a long expression wraps. Comments are left out.
 */
const expressionAt = (text: string, start: number): string => {
  let expression = "";
  let depth = 0;
  let quote: string | null = null;
  let index = start;
  while (index < text.length) {
    const character = text.charAt(index);
    // A plain string ends with its line; a template can go on.
    if (quote !== null && !(character === "\n" && quote !== "`")) {
      const taken = character === "\\" ? text.slice(index, index + 2) : character;
      expression += taken;
      quote = character === quote ? null : quote;
      index += taken.length;
      continue;
    }
    quote = null;
    if (text.startsWith("//", index)) {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "(" || character === "[" || character === "{") {
      depth += 1;
    } else if (character === ")" || character === "]" || character === "}") {
      if (depth === 0) {
        break;
      }
      depth -= 1;
    } else if (depth === 0 && (character === "," || character === ";")) {
      break;
    } else if (depth === 0 && character === "\n" && !/(?:\?\?|\|\|)\s*$/.test(expression) && !/^\s*(?:\?\?|\|\|)/.test(text.slice(index + 1))) {
      break;
    }
    expression += character;
    index += 1;
  }
  return expression.trim();
};

/** An env read, which holds no default of its own: `process.env.X`, `process.env["X"]`, `import.meta.env.X`. */
const ENV_READ = /\b(?:process|import\s*\.\s*meta)\s*\.\s*env\b(?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[\s*(["'`])[^"'`]*\1\s*\])?/g;

/** A port-sized number of its own: `3001`, `"3001"`, `localhost:3001`; not `v2`, `127.0.0.1` or a path's `/2024`. */
const LITERAL_PORT = /(?:^|[^\w.$/-])(\d{2,5})(?![\w.])/;

/** How many names one read follows through their declarations, at most. */
const MAX_NAMES = 32;

/**
 * The port an expression in the file gives, read as text and never evaluated. Its env reads are
 * dropped, as they hold no default; the fallback after its last `??` or `||` is read first, then
 * the whole. Each is read for a number of its own, else for a name the file declares, whose
 * declaration is read the same way: `process.env.API_URL ?? \`http://localhost:${apiPort}\`` with
 * `const apiPort = process.env.API_PORT ?? "3001"` gives 3001. `followed` holds the names this
 * read has looked up, each once.
 */
const portOfExpression = (expression: string, text: string, followed = new Set<string>()): number | null => {
  const read = expression.replace(ENV_READ, " ");
  const operator = [...read.matchAll(/\?\?|\|\|/g)].at(-1);
  const fallback = operator === undefined ? null : read.slice(operator.index + operator[0].length);
  for (const part of fallback === null ? [read] : [fallback, read]) {
    const literal = portOf(LITERAL_PORT.exec(part)?.[1]);
    if (literal !== null) {
      return literal;
    }
    for (const [name] of part.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      if (followed.has(name) || followed.size >= MAX_NAMES) {
        continue;
      }
      followed.add(name);
      const declared = declaredPort(text, name, followed);
      if (declared !== null) {
        return declared;
      }
    }
  }
  return null;
};

/**
 * The port a file's own declaration of `name` gives (`const apiPort = process.env.API_PORT ??
 * "3001"`, `const target = "http://localhost:3001"`): its expression, read by `portOfExpression`.
 * A config that moves its ports by a variable keeps its default in the text.
 */
const declaredPort = (text: string, name: string, followed: Set<string>): number | null => {
  if (!NAME.test(name)) {
    return null;
  }
  const declaration = new RegExp(`(?:^|[\\s;(])(?:const|let|var)\\s+${name}\\s*=\\s*`).exec(text);
  return declaration === null ? null : portOfExpression(expressionAt(text, declaration.index + declaration[0].length), text, followed);
};

/**
 * A Vite config's `server.port` and `server.proxy` keys (ADR 0068): read from its text, never
 * loaded, since loading a config runs it. A proxy's target names the port of the API behind it. A
 * port a variable holds (`port,`, `target: \`http://localhost:${apiPort}\``) is the number the
 * file declares that variable with, and one an env variable moves (`process.env.API_URL ??
 * "http://localhost:3001"`, with `||`, or in a template) is its fallback.
 */
export const readViteConfig = (text: string): DetectedViteConfig => {
  const server = blockOf(text, "server");
  if (server === null) {
    return { port: null, proxy: [] };
  }
  const proxyBlock = blockOf(server, "proxy");
  const outside = proxyBlock === null ? server : server.replace(proxyBlock, "");
  // `port: 4000`, `port: webPort`, `port: Number(process.env.PORT) || 4000`, or `port,` (the name `port` itself).
  const portEntry = /(?:^|[\s,{])port\s*(?:(:)\s*|(?=[,}\n]|$))/.exec(outside);
  const port = portEntry === null ? null : portOfExpression(portEntry[1] === undefined ? "port" : expressionAt(outside, portEntry.index + portEntry[0].length), text);
  const proxy: { path: string; targetPort: number | null }[] = [];
  if (proxyBlock !== null) {
    // `"/api": <target>`, or `"/api": { target: <target>, … }`, whose block is passed over.
    const entry = /(["'`])(\/[^"'`]*)\1\s*:\s*/g;
    for (let found = entry.exec(proxyBlock); found !== null; found = entry.exec(proxyBlock)) {
      const path = found[2] ?? "";
      const start = found.index + found[0].length;
      const block = proxyBlock.charAt(start) === "{" ? blockAt(proxyBlock, start) : null;
      const key = block === null ? null : /(?:^|[\s,{])target\s*:\s*/.exec(block);
      const target = block === null ? expressionAt(proxyBlock, start) : key === null ? "" : expressionAt(block, key.index + key[0].length);
      if (block !== null) {
        entry.lastIndex = start + block.length + 2;
      }
      proxy.push({ path, targetPort: portOfExpression(target, text) });
    }
  }
  return { port, proxy };
};

// ---------- the processes they suggest ----------

/** An app process detection proposes. The admin fills in what's `null`. */
export type DetectedAppProcess = {
  /** Lower-case letters, digits and dashes, unique among the proposed. */
  readonly name: string;
  readonly label: string;
  readonly port: number;
  /** The command that starts it, or `null` when no file says. Never logged. */
  readonly command: string | null;
  readonly folder: string;
  readonly ready: { readonly kind: "http"; readonly path: string } | { readonly kind: "port" };
  readonly primary: boolean;
  /** The file it was found in. */
  readonly source: string;
};

export type AppDetectionInput = {
  /** `package.json`, parsed, or `null`. */
  readonly packageJson: unknown;
  /** The devcontainer, parsed, or `null`. */
  readonly devcontainer: unknown;
  readonly devcontainerFile: string | null;
  /** The other files' text, by path (`appContentPaths`). */
  readonly files: ReadonlyMap<string, string>;
  /** The package manager detection chose, which runs a script: `pnpm`, `yarn`, `bun` or `npm`. */
  readonly manager: "pnpm" | "yarn" | "bun" | "npm";
};

export type AppDetection = {
  readonly processes: readonly DetectedAppProcess[];
  readonly reasons: readonly { readonly file: string; readonly finding: string }[];
};

const slug = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

/** A label from a script's or a path's name: `api` is "API", `docs` "Docs", `dev-api` "Dev api". */
const scriptLabel = (name: string): string => {
  if (name === "api") {
    return "API";
  }
  const words = name.replace(/-/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

/**
 * The app processes the repo's files suggest (ADR 0068): the dev server a `package.json` script
 * or a Vite config starts, as the primary, with each API its Vite proxy points at; the other
 * scripts that name their port; and the ports a devcontainer, `.gitpod.yml` or `.replit` names, a
 * file's preview hint winning the primary. Ports below 1024 are left out, as previews never reach
 * them; at most 10.
 */
export const detectAppProcesses = (input: AppDetectionInput): AppDetection => {
  const reasons: { file: string; finding: string }[] = [];
  const byPort = new Map<number, DetectedAppProcess>();
  const add = (process: DetectedAppProcess): void => {
    const known = byPort.get(process.port);
    byPort.set(
      process.port,
      known === undefined
        ? process
        : { ...known, label: known.label === `Port ${String(known.port)}` ? process.label : known.label, command: known.command ?? process.command, primary: known.primary || process.primary },
    );
  };
  const run = (script: string): string => (input.manager === "npm" ? `npm run ${script}` : `${input.manager} ${script}`);

  const viteFile = appContentPaths.filter((path) => path.startsWith("vite.config.")).find((path) => input.files.has(path));
  const vite = viteFile === undefined ? null : readViteConfig(input.files.get(viteFile) ?? "");
  const scripts = readPackageScripts(input.packageJson);
  const devScript = scripts.find((script) => script.script === "dev") ?? scripts[0];
  const webPort = vite?.port ?? devScript?.port ?? (vite === null ? null : 5173);
  if (webPort !== null && (devScript !== undefined || vite !== null)) {
    add({
      name: "web",
      label: "Web",
      port: webPort,
      command: devScript === undefined ? null : run(devScript.script),
      folder: ".",
      ready: { kind: "http", path: "/" },
      primary: true,
      source: viteFile ?? "package.json",
    });
    reasons.push({ file: viteFile ?? "package.json", finding: `a dev server on port ${String(webPort)}: proposed as the primary preview, Web` });
  }
  for (const proxy of vite?.proxy ?? []) {
    if (proxy.targetPort === null || proxy.targetPort === webPort) {
      continue;
    }
    const name = slug(proxy.path) === "" ? `api-${String(proxy.targetPort)}` : slug(proxy.path);
    add({ name, label: name === "api" ? "API" : name, port: proxy.targetPort, command: null, folder: ".", ready: { kind: "port" }, primary: false, source: viteFile ?? "vite.config" });
    reasons.push({ file: viteFile ?? "vite.config", finding: `${proxy.path} goes to port ${String(proxy.targetPort)} through the dev server's proxy: proposed as a process, with one origin kept` });
  }
  // Milestone 8 (ticket 15): another script that names its port serves something too, an API or a
  // docs site; it gives a process the proxy found its command.
  for (const script of readPortScripts(input.packageJson)) {
    if (script.port < 1024 || script.port === webPort) {
      continue;
    }
    const name = slug(script.script) === "" || /^\d/.test(slug(script.script)) ? `app-${String(script.port)}` : slug(script.script);
    add({ name, label: scriptLabel(name), port: script.port, command: run(script.script), folder: ".", ready: { kind: "port" }, primary: false, source: "package.json" });
    reasons.push({ file: "package.json", finding: `the ${script.script} script serves on port ${String(script.port)}: proposed as a process` });
  }
  const named: { readonly file: string; readonly ports: readonly DetectedPort[] }[] = [
    { file: input.devcontainerFile ?? ".devcontainer/devcontainer.json", ports: readDevcontainerPorts(input.devcontainer) },
    { file: ".gitpod.yml", ports: input.files.has(".gitpod.yml") ? readGitpodPorts(input.files.get(".gitpod.yml") ?? "") : [] },
    { file: ".replit", ports: input.files.has(".replit") ? readReplitPorts(input.files.get(".replit") ?? "") : [] },
  ];
  for (const { file, ports } of named) {
    for (const port of ports) {
      if (port.port < 1024) {
        reasons.push({ file, finding: `port ${String(port.port)} is below 1024: no preview reaches it, so it isn't proposed` });
        continue;
      }
      const label = port.label ?? `Port ${String(port.port)}`;
      add({
        name: slug(label) === "" || /^\d/.test(slug(label)) ? `app-${String(port.port)}` : slug(label),
        label,
        port: port.port,
        command: null,
        folder: ".",
        ready: { kind: "port" },
        primary: port.preview,
        source: file,
      });
      reasons.push({ file, finding: `port ${String(port.port)}${port.label === null ? "" : ` (${port.label})`}${port.preview ? ", opened as a preview" : ""}: proposed as a process` });
    }
  }
  // One primary: a file's preview hint first, then the dev server; names once.
  const all = [...byPort.values()];
  const hinted = all.find((process) => process.primary && process.source !== (viteFile ?? "package.json") && process.name !== "web");
  const primaryPort = hinted?.port ?? all.find((process) => process.primary)?.port ?? null;
  const names = new Set<string>();
  const processes = all.slice(0, 10).map((process) => {
    let name = process.name;
    for (let n = 2; names.has(name); n += 1) {
      name = `${process.name.slice(0, 36)}-${String(n)}`;
    }
    names.add(name);
    return { ...process, name, primary: process.port === primaryPort };
  });
  return { processes, reasons };
};
