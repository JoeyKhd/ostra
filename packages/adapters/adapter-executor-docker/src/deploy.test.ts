import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pinnedChecksums } from "@ostra/adapter-opencode";
import { redactTokens } from "@ostra/adapter-sdk";
import { describe, expect, it } from "vitest";

// Ticket 22: the Dockerfiles and the compose file, checked without Docker (hadolint isn't added).
// The compose file is read with a small reader for the YAML it uses: block maps, block lists,
// inline lists and quoted scalars.

const deploy = (file: string): Promise<string> => readFile(fileURLToPath(new URL(`../../../../deploy/${file}`, import.meta.url)), "utf8");

type Yaml = string | readonly Yaml[] | { readonly [key: string]: Yaml };

const isList = (value: Yaml): value is readonly Yaml[] => Array.isArray(value);

const stripComment = (line: string): string => {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#" && (index === 0 || line[index - 1] === " ")) {
      return line.slice(0, index);
    }
  }
  return line;
};

const scalar = (text: string): Yaml => {
  const value = text.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((item) => scalar(item));
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
};

/** Parses the subset of YAML deploy/compose.yaml uses. Throws on anything else. */
export const parseYaml = (text: string): Yaml => {
  const lines = text
    .split(/\r?\n/)
    .map(stripComment)
    .filter((line) => line.trim().length > 0)
    .map((line) => ({ indent: line.length - line.trimStart().length, text: line.trim() }));
  let position = 0;
  const block = (indent: number): Yaml => {
    const first = lines[position];
    if (first === undefined) {
      return "";
    }
    if (first.text.startsWith("- ")) {
      const items: Yaml[] = [];
      while (lines[position]?.indent === indent && lines[position]?.text.startsWith("- ") === true) {
        items.push(scalar(lines[position]?.text.slice(2) ?? ""));
        position += 1;
      }
      return items;
    }
    const map: Record<string, Yaml> = {};
    while (lines[position] !== undefined && lines[position]?.indent === indent) {
      const line = lines[position];
      if (line === undefined) {
        break;
      }
      const colon = line.text.indexOf(":");
      if (colon <= 0) {
        throw new Error(`not a key: ${line.text}`);
      }
      const key = line.text.slice(0, colon).trim().replace(/^["']|["']$/g, "");
      const rest = line.text.slice(colon + 1).trim();
      position += 1;
      if (rest === "") {
        const next = lines[position];
        map[key] = next !== undefined && next.indent > indent ? block(next.indent) : "";
      } else {
        map[key] = scalar(rest);
      }
    }
    return map;
  };
  return block(0);
};

const at = (value: Yaml, ...keys: string[]): Yaml => {
  let current: Yaml = value;
  for (const key of keys) {
    if (typeof current !== "object" || Array.isArray(current)) {
      throw new Error(`no ${key}`);
    }
    const next: Yaml | undefined = Object.entries(current).find(([name]) => name === key)?.[1];
    if (next === undefined) {
      throw new Error(`no ${key}`);
    }
    current = next;
  }
  return current;
};

const scalarsOf = (value: Yaml): readonly string[] =>
  typeof value === "string" ? [value] : isList(value) ? value.flatMap(scalarsOf) : Object.values(value).flatMap(scalarsOf);

const pairsOf = (value: Yaml, prefix = ""): readonly (readonly [string, string])[] =>
  typeof value === "string"
    ? [[prefix, value]]
    : isList(value)
      ? value.flatMap((item) => pairsOf(item, prefix))
      : Object.entries(value).flatMap(([key, item]: [string, Yaml]) => pairsOf(item, key));

describe("deploy/compose.yaml", () => {
  it("runs the server (all), Postgres and one pool runner on the docker executor", async () => {
    const compose = parseYaml(await deploy("compose.yaml"));
    expect(Object.keys(at(compose, "services")).sort()).toEqual(["base", "postgres", "runner", "server"]);
    expect(at(compose, "services", "server", "command")).toEqual(["all"]);
    expect(at(compose, "services", "server", "ports")).toEqual(["3000:3000", "8787:8787"]);
    expect(at(compose, "services", "runner", "environment", "OSTRA_RUNNER_EXECUTOR")).toBe("docker");
    expect(at(compose, "services", "runner", "environment", "OSTRA_JOIN_TOKEN_FILE")).toBe("/var/lib/ostra-server/bootstrap-join-token");
    expect(at(compose, "services", "runner", "volumes")).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(at(compose, "services", "runner", "volumes")).toContain("server-data:/var/lib/ostra-server:ro");
    expect(at(compose, "services", "server", "environment", "OSTRA_DATA_DIR")).toBe("/var/lib/ostra");
  });

  it("says the Docker socket is root on the host, and where pools belong", async () => {
    const text = await deploy("compose.yaml");
    expect(text).toMatch(/socket below is root on this host \(Q97\)/);
    expect(text).toMatch(/pool runners belong on dedicated hosts/);
  });

  it("holds no secret value", async () => {
    const text = await deploy("compose.yaml");
    const compose = parseYaml(text);
    for (const [key, value] of pairsOf(compose)) {
      if (/PASSWORD|SECRET|TOKEN$|_KEY$/i.test(key)) {
        expect(value, key).toMatch(/^\$\{[A-Z_]+(?::-[^}]*)?\}$|^\//);
      }
    }
    // Paths and URLs are long runs of the characters a token uses: the token check reads the rest.
    for (const value of scalarsOf(compose).filter((item) => !item.includes("/"))) {
      expect(redactTokens(value), value).toBe(value);
    }
    expect(text).not.toMatch(/POSTGRES_PASSWORD:/);
  });
});

describe("the Dockerfiles", () => {
  it("pin every base image to an exact version", async () => {
    for (const file of ["Dockerfile.server", "Dockerfile.runner", "Dockerfile.base"]) {
      const froms = [...(await deploy(file)).matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1] ?? "");
      expect(froms.length, file).toBeGreaterThan(0);
      for (const image of froms) {
        expect(image === "base" || image === "prune" || image === "build" || image === "init" || image === "opencode" || /:\d+\.\d+\.\d+-/.test(image), `${file}: ${image}`).toBe(true);
      }
    }
  });

  it("check OpenCode against the SHA-256s the OpenCode adapter pins", async () => {
    const text = await deploy("Dockerfile.base");
    expect(text).toContain("@opencode/cli@2.3.2");
    expect(text).toContain("--ignore-scripts");
    expect(text).toContain(`pkg=cli-linux-x64; sum=${pinnedChecksums["@opencode/cli-linux-x64"] ?? "missing"}`);
    expect(text).toContain(`pkg=cli-linux-arm64; sum=${pinnedChecksums["@opencode/cli-linux-arm64"] ?? "missing"}`);
    expect(text).toContain("sha256sum -c");
  });

  it("start the init at the path a box names, under tini", async () => {
    const text = await deploy("Dockerfile.base");
    expect(text).toContain('ENTRYPOINT ["tini", "--"]');
    expect(text).toContain("/opt/ostra/init/main.ts");
    expect(text).toContain("/opt/ostra/catalog/models-dev.json");
  });

  it("run the server as `web`, `core` or `all`, and the runner as the CLI", async () => {
    expect(await deploy("Dockerfile.server")).toContain('CMD ["all"]');
    expect(await deploy("server-entrypoint.sh")).toMatch(/web\)[\s\S]*core\)[\s\S]*all\)/);
    expect(await deploy("Dockerfile.runner")).toContain('ENTRYPOINT ["node", "/app/apps/runner/src/main.ts"]');
  });
});

describe("the YAML reader", () => {
  it("reads maps, lists, inline lists and quoted scalars, and refuses what it doesn't know", () => {
    expect(parseYaml("a:\n  b: 'x'\n  c: [1, \"2\"]\n  d:\n    - e # comment\n")).toEqual({ a: { b: "x", c: ["1", "2"], d: ["e"] } });
    expect(() => parseYaml("just text\n")).toThrow();
  });
});
