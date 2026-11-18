// Environment detection (F-112, ticket 32): a draft environment from what is in the repo, without
// an agent or a model. A pure function: it gets the repo's file list and the contents of the files
// it asked for, and returns the draft with the reasons for each line, so the panel can show them.
// It reads the repo's root only; a monorepo's packages are an admin's edit in milestone 1.
//
// Two steps, so the caller reads only what is needed:
//   1. `pathsToRead(tree)`: the files whose contents it wants (everything well-known when the host
//      can't list the repo's files, and then lockfiles too, for their presence).
//   2. `detectEnvironment({ tree, files })`: the draft, from the tree and those files.

/** The root files whose contents detection reads. */
export const contentPaths = [
  "package.json",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  ".python-version",
  "rust-toolchain.toml",
  ".env.example",
  ".devcontainer/devcontainer.json",
  ".devcontainer.json",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "requirements.txt",
  "requirements-dev.txt",
] as const;

/** Lockfiles: only their presence matters, so they are read only when the host can't list files. */
export const lockfilePaths = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "poetry.lock",
  "uv.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
] as const;

export type DetectionReason = {
  /** The file the finding comes from. */
  readonly file: string;
  /** What was found there and what the draft does about it. */
  readonly finding: string;
};

export type DetectedVariable = {
  readonly name: string;
  /** Guessed from the name: a token, key or password is a secret. The admin confirms. */
  readonly secret: boolean;
  readonly source: string;
};

export type DetectedService = {
  readonly name: string;
  readonly image: string | null;
  readonly ports: readonly number[];
  readonly source: string;
  /** A service needs a container runtime: it isn't run on the `host` executor (spec section 11). */
  readonly runsOnHost: false;
};

export type DetectedTool = {
  readonly tool: string;
  readonly version: string;
  readonly source: string;
};

export type DetectedEnvironment = {
  /** A devcontainer's image, for the `docker` executor. */
  readonly baseImage: string | null;
  readonly setupLines: readonly string[];
  /** The setup lines as a script (`null` when there are none). */
  readonly setupScript: string | null;
  readonly variables: readonly DetectedVariable[];
  readonly tools: readonly DetectedTool[];
  readonly services: readonly DetectedService[];
  readonly reasons: readonly DetectionReason[];
};

export type DetectionInput = {
  /** Every file path in the repo, or `null` when the host can't list them. */
  readonly tree: readonly string[] | null;
  /** The contents of the files `pathsToRead` asked for that exist. */
  readonly files: ReadonlyMap<string, string>;
};

/** Which files to read, given the repo's file list (or `null`: ask for every well-known path). */
export const pathsToRead = (tree: readonly string[] | null): readonly string[] => {
  if (tree === null) {
    return [...contentPaths, ...lockfilePaths];
  }
  const present = new Set(tree);
  return contentPaths.filter((path) => present.has(path));
};

// ---------- small parsers ----------

/** JSON with comments and trailing commas, as a `devcontainer.json` is. `null` when it isn't JSON at all. */
export const parseJsonc = (text: string): unknown => {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    const next = text.charAt(i + 1);
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next;
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (i < text.length && text.charAt(i) !== "\n") {
        i += 1;
      }
      out += "\n";
    } else if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text.charAt(i) === "*" && text.charAt(i + 1) === "/")) {
        i += 1;
      }
      i += 1;
    } else {
      out += char;
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (record: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

const SECRET_NAME = /(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH|DSN|SALT|SIGNING|ENCRYPTION)|(?:^|_)KEY$/i;
const PUBLIC_NAME = /^(?:NEXT_PUBLIC|PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|NUXT_PUBLIC)_/;

/** Whether a variable's name says it is a secret. */
export const looksSecret = (name: string): boolean => !PUBLIC_NAME.test(name) && SECRET_NAME.test(name);

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

const parseEnvExample = (text: string): readonly string[] => {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) {
      continue;
    }
    const name = ENV_LINE.exec(line)?.[1];
    if (name !== undefined && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
};

const unquote = (value: string): string => value.trim().replace(/^(["'])(.*)\1$/, "$2");

/** A compose file's services, from the lines that matter: a name, an image and its ports. */
const parseCompose = (text: string, source: string): readonly DetectedService[] => {
  const services: DetectedService[] = [];
  const lines = text.split(/\r?\n/);
  let inServices = false;
  let serviceIndent = -1;
  let current: { name: string; image: string | null; ports: number[]; indent: number } | null = null;
  let inPorts = false;
  let portsIndent = -1;
  const finish = (): void => {
    if (current !== null) {
      services.push({ name: current.name, image: current.image, ports: current.ports, source, runsOnHost: false });
    }
    current = null;
    inPorts = false;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 0) {
      finish();
      inServices = body === "services:";
      serviceIndent = -1;
      continue;
    }
    if (!inServices) {
      continue;
    }
    if (serviceIndent === -1) {
      serviceIndent = indent;
    }
    if (indent === serviceIndent) {
      finish();
      const name = /^([A-Za-z0-9_.-]+):\s*$/.exec(body)?.[1];
      current = name === undefined ? null : { name, image: null, ports: [], indent };
      continue;
    }
    if (current === null) {
      continue;
    }
    const image = /^image:\s*(.+)$/.exec(body)?.[1];
    if (image !== undefined && indent > current.indent) {
      current.image = unquote(image);
      inPorts = false;
      continue;
    }
    if (/^ports:\s*$/.test(body)) {
      inPorts = true;
      portsIndent = indent;
      continue;
    }
    if (inPorts) {
      if (indent <= portsIndent) {
        inPorts = false;
        continue;
      }
      const item = /^-\s*(.+)$/.exec(body)?.[1];
      if (item !== undefined) {
        const container = unquote(item).split("/")[0]?.split(":").at(-1);
        const port = Number(container);
        if (Number.isInteger(port) && port > 0 && port < 65_536) {
          current.ports.push(port);
        }
      }
    }
  }
  finish();
  return services;
};

// ---------- the detector ----------

type NodeManager = "pnpm" | "yarn" | "bun" | "npm";

const nodeLockfiles: readonly { readonly file: string; readonly manager: NodeManager }[] = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "bun.lock", manager: "bun" },
  { file: "package-lock.json", manager: "npm" },
];

const nodeManagerOf = (value: string): NodeManager | null => {
  const name = value.split("@")[0];
  return name === "pnpm" || name === "yarn" || name === "bun" || name === "npm" ? name : null;
};

const toolName = (name: string): string => (name === "nodejs" ? "node" : name);

export const detectEnvironment = (input: DetectionInput): DetectedEnvironment => {
  const { files } = input;
  const tree = input.tree === null ? null : new Set(input.tree);
  const exists = (path: string): boolean => (tree === null ? files.has(path) : tree.has(path));

  const lines: string[] = [];
  const reasons: DetectionReason[] = [];
  const variables: DetectedVariable[] = [];
  const tools: DetectedTool[] = [];
  let services: readonly DetectedService[] = [];
  let baseImage: string | null = null;

  const setup = (file: string, finding: string, ...commands: string[]): void => {
    for (const command of commands) {
      if (!lines.includes(command)) {
        lines.push(command);
      }
    }
    reasons.push({ file, finding });
  };
  const note = (file: string, finding: string): void => {
    reasons.push({ file, finding });
  };

  // ---- Node: package.json and its lockfile ----
  const packageText = files.get("package.json");
  let declaredManager: NodeManager | null = null;
  let packageManagerText: string | null = null;
  if (packageText !== undefined) {
    const parsed: unknown = parseJsonc(packageText);
    if (isRecord(parsed)) {
      const packageManager = stringField(parsed, "packageManager");
      if (packageManager !== null) {
        declaredManager = nodeManagerOf(packageManager);
        packageManagerText = packageManager;
        note("package.json", `packageManager is ${packageManager}`);
        const [, version] = packageManager.split("@");
        if (declaredManager !== null && version !== undefined) {
          tools.push({ tool: declaredManager, version: version.split("+")[0] ?? version, source: "package.json" });
        }
      }
      const engines = parsed["engines"];
      if (isRecord(engines)) {
        const node = stringField(engines, "node");
        if (node !== null) {
          tools.push({ tool: "node", version: node, source: "package.json" });
          note("package.json", `engines.node is ${node}`);
        }
      }
    } else {
      note("package.json", "could not be read as JSON: skipped");
    }
    const present = nodeLockfiles.filter((lock) => exists(lock.file));
    const chosen = present.find((lock) => lock.manager === declaredManager) ?? present[0];
    if (chosen === undefined) {
      setup("package.json", "has no lockfile: installs with `npm install`", "npm install");
    } else {
      switch (chosen.manager) {
        case "pnpm":
          setup(chosen.file, "pnpm lockfile: installs with `pnpm install --frozen-lockfile`", "corepack enable", "pnpm install --frozen-lockfile");
          break;
        case "yarn": {
          const modern = declaredManager === "yarn" && /^yarn@(?:[2-9]|\d{2,})/.test(packageManagerText ?? "");
          setup(
            chosen.file,
            modern ? "yarn lockfile (Yarn 2 or newer): installs with `yarn install --immutable`" : "yarn lockfile: installs with `yarn install --frozen-lockfile`",
            "corepack enable",
            modern ? "yarn install --immutable" : "yarn install --frozen-lockfile",
          );
          break;
        }
        case "bun":
          setup(chosen.file, "bun lockfile: installs with `bun install --frozen-lockfile`", "bun install --frozen-lockfile");
          break;
        case "npm":
          setup(chosen.file, "npm lockfile: installs with `npm ci`", "npm ci");
          break;
        default:
          chosen.manager satisfies never;
      }
      for (const other of present) {
        if (other !== chosen) {
          note(other.file, `also present; the draft installs with ${chosen.manager}, which ${declaredManager === chosen.manager ? "package.json names" : "comes first"}`);
        }
      }
    }
  } else if (exists("package-lock.json") || exists("pnpm-lock.yaml") || exists("yarn.lock") || exists("bun.lock")) {
    note("package.json", "a lockfile exists but package.json couldn't be read: no Node install drafted");
  }

  // ---- other ecosystems, by lockfile ----
  if (exists("poetry.lock")) {
    setup("poetry.lock", "Poetry lockfile: installs with `poetry install`", "poetry install");
  }
  if (exists("uv.lock")) {
    setup("uv.lock", "uv lockfile: installs with `uv sync --frozen`", "uv sync --frozen");
  }
  for (const requirements of ["requirements.txt", "requirements-dev.txt"] as const) {
    if (files.has(requirements)) {
      setup(requirements, `pip requirements: installs with \`pip install -r ${requirements}\``, `pip install -r ${requirements}`);
    }
  }
  if (exists("Cargo.lock")) {
    setup("Cargo.lock", "Cargo lockfile: fetches with `cargo fetch --locked`", "cargo fetch --locked");
  }
  if (exists("go.sum")) {
    setup("go.sum", "Go modules: downloads with `go mod download`", "go mod download");
  }
  if (exists("Gemfile.lock")) {
    setup("Gemfile.lock", "Bundler lockfile: installs with `bundle install`", "bundle install");
  }

  // ---- tool versions ----
  for (const file of [".nvmrc", ".node-version"] as const) {
    const text = files.get(file);
    const version = text?.trim().replace(/^v/, "");
    if (version !== undefined && version !== "") {
      tools.push({ tool: "node", version, source: file });
      note(file, `Node ${version}`);
    }
  }
  const asdf = files.get(".tool-versions");
  if (asdf !== undefined) {
    for (const line of asdf.split(/\r?\n/)) {
      const [name, version] = line.split("#")[0]?.trim().split(/\s+/) ?? [];
      if (name !== undefined && name !== "" && version !== undefined) {
        tools.push({ tool: toolName(name), version, source: ".tool-versions" });
        note(".tool-versions", `${toolName(name)} ${version}`);
      }
    }
  }
  const python = files.get(".python-version")?.trim();
  if (python !== undefined && python !== "") {
    tools.push({ tool: "python", version: python, source: ".python-version" });
    note(".python-version", `Python ${python}`);
  }
  const rust = /channel\s*=\s*"([^"]+)"/.exec(files.get("rust-toolchain.toml") ?? "")?.[1];
  if (rust !== undefined) {
    tools.push({ tool: "rust", version: rust, source: "rust-toolchain.toml" });
    note("rust-toolchain.toml", `Rust ${rust}`);
  }

  // ---- .env.example ----
  const envExample = files.get(".env.example");
  if (envExample !== undefined) {
    const names = parseEnvExample(envExample);
    for (const name of names) {
      variables.push({ name, secret: looksSecret(name), source: ".env.example" });
    }
    const secrets = variables.filter((variable) => variable.secret).length;
    note(
      ".env.example",
      `${String(names.length)} variable${names.length === 1 ? "" : "s"} (${String(secrets)} guessed secret from the name); values are left empty`,
    );
  }

  // ---- devcontainer ----
  for (const file of [".devcontainer/devcontainer.json", ".devcontainer.json"] as const) {
    const text = files.get(file);
    if (text === undefined) {
      continue;
    }
    const parsed = parseJsonc(text);
    if (!isRecord(parsed)) {
      note(file, "could not be read as JSON: skipped");
      continue;
    }
    const image = stringField(parsed, "image");
    if (image !== null && baseImage === null) {
      baseImage = image;
      note(file, `image ${image}: the base image for the \`docker\` executor`);
    }
    if (isRecord(parsed["build"])) {
      note(file, "builds from a Dockerfile: not used as the base image in milestone 1");
    }
    const post = parsed["postCreateCommand"];
    const commands = typeof post === "string"
      ? [post]
      : Array.isArray(post)
        ? [post.filter((part): part is string => typeof part === "string").join(" ")]
        : isRecord(post)
          ? Object.values(post).flatMap((value) => (typeof value === "string" ? [value] : []))
          : [];
    const usable = commands.map((command) => command.trim()).filter((command) => command !== "");
    if (usable.length > 0) {
      setup(file, "postCreateCommand becomes setup lines", ...usable);
    }
  }

  // ---- compose files ----
  const found: DetectedService[] = [];
  for (const file of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"] as const) {
    const text = files.get(file);
    if (text === undefined) {
      continue;
    }
    const detected = parseCompose(text, file);
    found.push(...detected.filter((service) => !found.some((existing) => existing.name === service.name)));
    note(
      file,
      detected.length === 0
        ? "no services found"
        : `services ${detected.map((service) => service.name).join(", ")}: drafted, and not run on the \`host\` executor`,
    );
  }
  services = found;

  return {
    baseImage,
    setupLines: lines,
    setupScript: lines.length === 0 ? null : `set -euo pipefail\n${lines.join("\n")}\n`,
    variables,
    tools,
    services,
    reasons,
  };
};

