import { describe, expect, it } from "vitest";

import { detectEnvironment, looksSecret, parseJsonc, pathsToRead } from "./detect.ts";

// Detection has a test per file type the ticket lists, and a fixture repo with several at once.

const detect = (files: Record<string, string>, tree: readonly string[] | null = null) =>
  detectEnvironment({ tree, files: new Map(Object.entries(files)) });

const reasonFiles = (files: Record<string, string>, tree: readonly string[] | null = null) =>
  detect(files, tree).reasons.map((reason) => reason.file);

describe("lockfiles and package managers", () => {
  it("pnpm-lock.yaml installs with pnpm", () => {
    const draft = detect({ "package.json": "{}", "pnpm-lock.yaml": "lockfileVersion: 9" });
    expect(draft.setupLines).toEqual(["corepack enable", "pnpm install --frozen-lockfile"]);
    expect(reasonFiles({ "package.json": "{}", "pnpm-lock.yaml": "x" })).toContain("pnpm-lock.yaml");
  });

  it("package-lock.json installs with npm ci", () => {
    expect(detect({ "package.json": "{}", "package-lock.json": "{}" }).setupLines).toEqual(["npm ci"]);
  });

  it("yarn.lock installs with yarn, and a Yarn 2 or newer packageManager uses --immutable", () => {
    expect(detect({ "package.json": "{}", "yarn.lock": "" }).setupLines).toEqual(["corepack enable", "yarn install --frozen-lockfile"]);
    expect(detect({ "package.json": '{"packageManager":"yarn@4.5.0"}', "yarn.lock": "" }).setupLines).toEqual([
      "corepack enable",
      "yarn install --immutable",
    ]);
  });

  it("bun.lock installs with bun", () => {
    expect(detect({ "package.json": "{}", "bun.lock": "" }).setupLines).toEqual(["bun install --frozen-lockfile"]);
  });

  it("package.json's packageManager decides between lockfiles, and the reasons name the one not used", () => {
    const draft = detect({
      "package.json": '{"packageManager":"npm@10.8.0"}',
      "pnpm-lock.yaml": "",
      "package-lock.json": "{}",
    });
    expect(draft.setupLines).toEqual(["npm ci"]);
    expect(draft.reasons.find((reason) => reason.file === "pnpm-lock.yaml")?.finding).toContain("also present");
    expect(draft.tools).toContainEqual({ tool: "npm", version: "10.8.0", source: "package.json" });
  });

  it("with several lockfiles and no packageManager, pnpm comes first", () => {
    expect(detect({ "package.json": "{}", "package-lock.json": "{}", "pnpm-lock.yaml": "" }).setupLines).toContain("pnpm install --frozen-lockfile");
  });

  it("a package.json with no lockfile installs with npm install, and says why", () => {
    const draft = detect({ "package.json": "{}" });
    expect(draft.setupLines).toEqual(["npm install"]);
    expect(draft.reasons[0]?.file).toBe("package.json");
    expect(draft.reasons[0]?.finding).toContain("no lockfile");
  });

  it("package.json's engines.node is a tool version", () => {
    expect(detect({ "package.json": '{"engines":{"node":">=22"}}' }).tools).toContainEqual({ tool: "node", version: ">=22", source: "package.json" });
  });

  it("poetry.lock, uv.lock, requirements*.txt, Cargo.lock, go.sum and Gemfile.lock each draft their install", () => {
    expect(detect({ "poetry.lock": "" }).setupLines).toEqual(["poetry install"]);
    expect(detect({ "uv.lock": "" }).setupLines).toEqual(["uv sync --frozen"]);
    expect(detect({ "requirements.txt": "flask", "requirements-dev.txt": "pytest" }).setupLines).toEqual([
      "pip install -r requirements.txt",
      "pip install -r requirements-dev.txt",
    ]);
    expect(detect({ "Cargo.lock": "" }).setupLines).toEqual(["cargo fetch --locked"]);
    expect(detect({ "go.sum": "" }).setupLines).toEqual(["go mod download"]);
    expect(detect({ "Gemfile.lock": "" }).setupLines).toEqual(["bundle install"]);
  });

  it("an unreadable package.json is skipped with a reason, not a crash", () => {
    const draft = detect({ "package.json": "{not json" });
    expect(draft.reasons[0]?.file).toBe("package.json");
    expect(draft.reasons[0]?.finding).toContain("could not be read");
  });

  it("an empty repo drafts nothing", () => {
    expect(detect({})).toMatchObject({ setupLines: [], setupScript: null, variables: [], services: [], tools: [], reasons: [], baseImage: null });
  });

  it("makes the setup script from the lines: strict shell, one command per line", () => {
    expect(detect({ "package.json": "{}", "package-lock.json": "{}" }).setupScript).toBe("set -euo pipefail\nnpm ci\n");
  });
});

describe("tool versions", () => {
  it(".nvmrc and .node-version name Node, without the leading v", () => {
    expect(detect({ ".nvmrc": "v22.11.0\n" }).tools).toEqual([{ tool: "node", version: "22.11.0", source: ".nvmrc" }]);
    expect(detect({ ".node-version": "20\n" }).tools).toEqual([{ tool: "node", version: "20", source: ".node-version" }]);
  });

  it(".tool-versions lists each tool, with nodejs as node and comments dropped", () => {
    expect(detect({ ".tool-versions": "nodejs 20.11.0\npython 3.12.1 # pinned\n\nrust 1.80.0\n" }).tools).toEqual([
      { tool: "node", version: "20.11.0", source: ".tool-versions" },
      { tool: "python", version: "3.12.1", source: ".tool-versions" },
      { tool: "rust", version: "1.80.0", source: ".tool-versions" },
    ]);
  });

  it(".python-version and rust-toolchain.toml", () => {
    expect(detect({ ".python-version": "3.12.4\n" }).tools).toEqual([{ tool: "python", version: "3.12.4", source: ".python-version" }]);
    expect(detect({ "rust-toolchain.toml": '[toolchain]\nchannel = "1.82.0"\n' }).tools).toEqual([
      { tool: "rust", version: "1.82.0", source: "rust-toolchain.toml" },
    ]);
  });
});

describe(".env.example", () => {
  const example = [
    "# the app",
    "DATABASE_URL=postgres://localhost/app",
    "export STRIPE_SECRET_KEY=sk_test_abc",
    "NEXT_PUBLIC_API_KEY=pk_live",
    "API_TOKEN=",
    "PORT=3000",
    "  # COMMENTED=1",
    "DATABASE_URL=again",
    "lower_case = fine",
    "not a variable",
  ].join("\n");

  it("lists the variable names once, leaves values empty, and guesses secrets by name", () => {
    const { variables } = detect({ ".env.example": example });
    expect(variables.map((variable) => [variable.name, variable.secret])).toEqual([
      ["DATABASE_URL", false],
      ["STRIPE_SECRET_KEY", true],
      ["NEXT_PUBLIC_API_KEY", false],
      ["API_TOKEN", true],
      ["PORT", false],
      ["lower_case", false],
    ]);
    // Nothing of a value leaks into the draft: not in a variable, not in a reason.
    expect(JSON.stringify(detect({ ".env.example": example }))).not.toContain("sk_test_abc");
    expect(JSON.stringify(detect({ ".env.example": example }))).not.toContain("postgres://");
  });

  it("explains itself in the reasons", () => {
    expect(detect({ ".env.example": example }).reasons[0]).toMatchObject({ file: ".env.example" });
  });

  it("guesses secrets from the usual words", () => {
    for (const name of ["SECRET", "GITHUB_TOKEN", "DB_PASSWORD", "AWS_ACCESS_KEY_ID", "OPENAI_API_KEY", "SENTRY_DSN", "ENCRYPTION_KEY", "PRIVATE_KEY"]) {
      expect(looksSecret(name), name).toBe(true);
    }
    for (const name of ["PORT", "NODE_ENV", "DATABASE_URL", "NEXT_PUBLIC_KEY", "VITE_API_TOKEN", "LOG_LEVEL"]) {
      expect(looksSecret(name), name).toBe(false);
    }
  });
});

describe("devcontainer.json", () => {
  const devcontainer = `{
    // a comment, and a trailing comma below
    "image": "mcr.microsoft.com/devcontainers/typescript-node:22",
    "postCreateCommand": "npm ci && npm run build", /* block */
    "features": { "ghcr.io/devcontainers/features/git:1": {}, },
  }`;

  it("reads JSON with comments: the image is the base image, postCreateCommand a setup line", () => {
    const draft = detect({ ".devcontainer/devcontainer.json": devcontainer });
    expect(draft.baseImage).toBe("mcr.microsoft.com/devcontainers/typescript-node:22");
    expect(draft.setupLines).toEqual(["npm ci && npm run build"]);
  });

  it("takes an array or an object postCreateCommand too", () => {
    expect(detect({ ".devcontainer.json": '{"postCreateCommand":["npm","ci"]}' }).setupLines).toEqual(["npm ci"]);
    expect(detect({ ".devcontainer.json": '{"postCreateCommand":{"a":"make a","b":"make b"}}' }).setupLines).toEqual(["make a", "make b"]);
  });

  it("notes a Dockerfile build instead of guessing an image", () => {
    const draft = detect({ ".devcontainer.json": '{"build":{"dockerfile":"Dockerfile"}}' });
    expect(draft.baseImage).toBeNull();
    expect(draft.reasons[0]?.finding).toContain("Dockerfile");
  });

  it("parseJsonc keeps comment-like text inside strings, and answers null for what isn't JSON", () => {
    expect(parseJsonc('{"url":"http://example.com/a//b", /* c */ "n":1,}')).toEqual({ url: "http://example.com/a//b", n: 1 });
    expect(parseJsonc("not json")).toBeNull();
  });
});

describe("compose files", () => {
  const compose = [
    "name: app",
    "services:",
    "  db:",
    "    image: postgres:16 # the database",
    "    ports:",
    '      - "5432:5432"',
    "    environment:",
    "      POSTGRES_PASSWORD: x",
    "  cache:",
    "    image: 'redis:7'",
    "    ports:",
    "      - 127.0.0.1:6379:6379",
    "      - 6380/tcp",
    "  web:",
    "    build: .",
    "volumes:",
    "  data: {}",
  ].join("\n");

  it("drafts the services with their images and ports, marked as not run on host", () => {
    const { services, reasons } = detect({ "docker-compose.yml": compose });
    expect(services).toEqual([
      { name: "db", image: "postgres:16", ports: [5432], source: "docker-compose.yml", runsOnHost: false },
      { name: "cache", image: "redis:7", ports: [6379, 6380], source: "docker-compose.yml", runsOnHost: false },
      { name: "web", image: null, ports: [], source: "docker-compose.yml", runsOnHost: false },
    ]);
    expect(reasons[0]?.finding).toContain("not run on the `host` executor");
  });

  it("reads compose.yaml and docker-compose.yaml the same, and a service once", () => {
    expect(detect({ "compose.yaml": compose }).services).toHaveLength(3);
    expect(detect({ "docker-compose.yaml": compose, "compose.yml": compose }).services).toHaveLength(3);
  });

  it("never copies a service's environment into the draft", () => {
    expect(JSON.stringify(detect({ "docker-compose.yml": compose }))).not.toContain("POSTGRES_PASSWORD");
  });
});

describe("reading less: pathsToRead and the file list", () => {
  it("asks for every well-known path, lockfiles included, when the host can't list files", () => {
    const paths = pathsToRead(null);
    expect(paths).toContain("package.json");
    expect(paths).toContain("pnpm-lock.yaml");
  });

  it("asks only for content files that exist when it has the list, never a lockfile", () => {
    expect(pathsToRead(["package.json", "pnpm-lock.yaml", "src/index.ts", ".env.example"])).toEqual(["package.json", ".env.example"]);
  });

  it("uses the list for a lockfile's presence, without its contents", () => {
    const tree = ["package.json", "pnpm-lock.yaml"];
    const draft = detect({ "package.json": "{}" }, tree);
    expect(draft.setupLines).toEqual(["corepack enable", "pnpm install --frozen-lockfile"]);
    expect(reasonFiles({ "package.json": "{}" }, tree)).toContain("pnpm-lock.yaml");
  });
});

describe("a fixture repo with several of them at once", () => {
  const repo = {
    "package.json": '{"name":"calc","packageManager":"pnpm@10.4.1","engines":{"node":">=22"}}',
    "pnpm-lock.yaml": "lockfileVersion: 9",
    ".nvmrc": "22\n",
    ".env.example": "DATABASE_URL=\nSESSION_SECRET=\nPORT=3000\n",
    ".devcontainer/devcontainer.json": '{ "image": "node:22", "postCreateCommand": "pnpm run db:setup" }',
    "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n    ports:\n      - 5432:5432\n",
    "requirements.txt": "mkdocs\n",
  };

  it("gathers the setup lines in a stable order, and every finding names its file", () => {
    const draft = detect(repo);
    expect(draft.setupLines).toEqual(["corepack enable", "pnpm install --frozen-lockfile", "pip install -r requirements.txt", "pnpm run db:setup"]);
    expect(draft.baseImage).toBe("node:22");
    expect(draft.variables.map((variable) => variable.name)).toEqual(["DATABASE_URL", "SESSION_SECRET", "PORT"]);
    expect(draft.services.map((service) => service.name)).toEqual(["db"]);
    expect(draft.tools.map((tool) => tool.tool).sort()).toEqual(["node", "node", "pnpm"]);
    const named = new Set(draft.reasons.map((reason) => reason.file));
    for (const file of ["package.json", "pnpm-lock.yaml", ".nvmrc", ".env.example", ".devcontainer/devcontainer.json", "docker-compose.yml", "requirements.txt"]) {
      expect(named, file).toContain(file);
    }
    expect(draft.setupScript?.startsWith("set -euo pipefail\n")).toBe(true);
  });

  it("is deterministic", () => {
    expect(detect(repo)).toEqual(detect(repo));
  });
});
