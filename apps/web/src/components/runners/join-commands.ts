import { releaseDownload, releaseFiles } from "@ostra/protocol";

// F-091, F-013, F-118 (ticket 30, pool-join.md): the three ways to start a pool runner with a join
// token. None of them carries the token: each reads it from a file (`OSTRA_JOIN_TOKEN_FILE`) or a
// Kubernetes secret, so it stays out of shell history, `ps` and the CI log a command was pasted into.
// The commands are built from the server's version and address and from where its release
// published the runner (F-039, ADR 0064): its image namespace, its CLI's npm name and its runner
// chart's download. They're never stored as messages.

export const joinPaths = ["cli", "docker", "helm"] as const;
export type JoinPath = (typeof joinPaths)[number];

export type JoinCommandInput = {
  /** Core's address as a runner reaches it (`OSTRA_CORE_PUBLIC_URL`). */
  readonly serverUrl: string;
  /** The server's own version: the runner starts pinned to it (spec section 4, "The pin"). */
  readonly serverVersion: string;
  /** Where the server's release pushed its images: the runner image is `<namespace>/runner:<version>`. */
  readonly imageNamespace: string;
  /** The npm name the server's release published the CLI under. */
  readonly cliPackage: string;
  /** The pool's executor when its runners share one; `docker` for a pool with no runner yet. */
  readonly executor: "docker" | "host" | "kubernetes";
};

/** The version of a build from a clone, which no release publishes (ADR 0045's one version line, before the stamp). */
const DEVELOPMENT_VERSION = "0.0.0";

/** The port a URL names, or its scheme's. */
const portOf = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.port === "" ? (parsed.protocol === "https:" ? "443" : "80") : parsed.port;
  } catch {
    return "443";
  }
};

/** The `helm install` line: the runner chart the server's own release attached, or, on a development build, a clone's. */
const helmInstall = (version: string): readonly string[] =>
  version === DEVELOPMENT_VERSION
    ? ["# A development build (0.0.0), which no release publishes: install the chart from your clone of ostra.", "# helm install ostra-runner ./deploy/helm/ostra-runner -n ostra -f values.yaml"]
    : [`# helm install ostra-runner ${releaseDownload(version, releaseFiles.runnerChart)} -n ostra -f values.yaml`];

/** The text a path's code box shows, and its `Copy` copies. */
export const joinCommand = (path: JoinPath, input: JoinCommandInput): string => {
  switch (path) {
    case "cli":
      return [
        "OSTRA_JOIN_TOKEN_FILE=./join-token \\",
        `  npx ${input.cliPackage}@${input.serverVersion} runner \\`,
        `  --server ${input.serverUrl} \\`,
        `  --executor ${input.executor}`,
      ].join("\n");
    case "docker":
      return [
        "docker run -d --name ostra-runner --restart unless-stopped --user root \\",
        "  -v /var/run/docker.sock:/var/run/docker.sock \\",
        "  -v /var/lib/ostra-runner:/var/lib/ostra-runner \\",
        '  -v "$PWD/join-token:/run/secrets/join-token:ro" \\',
        `  -e OSTRA_SERVER_URL=${input.serverUrl} \\`,
        "  -e OSTRA_RUNNER_EXECUTOR=docker \\",
        "  -e OSTRA_JOIN_TOKEN_FILE=/run/secrets/join-token \\",
        "  -e OSTRA_RUNNER_DATA_DIR=/var/lib/ostra-runner \\",
        `  ${input.imageNamespace}/runner:${input.serverVersion} runner`,
      ].join("\n");
    case "helm":
      // The `ostra-runner` chart's required values (deploy/helm/ostra-runner/values.yaml):
      // `server.url`, `server.egress` and `joinToken.existingSecret`. The release's chart defaults
      // its images to the release's own, under its namespace and at its version.
      return [
        "# kubectl -n ostra create secret generic ostra-join-token --from-file=join-token=./join-token",
        ...helmInstall(input.serverVersion),
        "server:",
        `  url: ${input.serverUrl}`,
        "  egress:",
        "    cidr: SERVER_ADDRESS/32  # the server's address, the one place a box may reach",
        `    port: ${portOf(input.serverUrl)}`,
        "joinToken:",
        "  existingSecret: ostra-join-token",
      ].join("\n");
    default:
      return path satisfies never;
  }
};

/** The tab selected on open: `Helm` for a pool whose runners all run `kubernetes`, else `ostra runner`. */
export const firstJoinPath = (executors: readonly string[]): JoinPath =>
  executors.length > 0 && executors.every((executor) => executor === "kubernetes") ? "helm" : "cli";

/** The executor `ostra runner --executor` names: the pool's one executor, else `docker`. */
export const joinExecutor = (executors: readonly string[]): JoinCommandInput["executor"] => {
  const [only, ...rest] = executors;
  return rest.length === 0 && (only === "host" || only === "kubernetes") ? only : "docker";
};
