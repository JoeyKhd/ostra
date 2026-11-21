// Milestone 8 (ticket 11, ADR 0068): what a box's browser needs in a container beyond the flags it
// runs with everywhere (`boxBrowserFlags`), and why. The init adds these on `docker` and
// `kubernetes`; on `host` the machine's browser runs with its own sandbox and gets none.
//
// **Chromium's own sandbox can't start in a box, and the box is the boundary instead.** On Linux,
// Chromium puts each renderer in fresh PID and network namespaces, made through an unprivileged user
// namespace, or else through its setuid helper `chrome-sandbox`; with neither it refuses to start
// ("No usable sandbox!") unless it's given `--no-sandbox`
// (https://github.com/chromium/chromium/blob/main/sandbox/linux/README.md;
// https://pptr.dev/troubleshooting, both read 2026-11-21). A box allows neither:
// - Docker's default seccomp profile, and containerd's `RuntimeDefault`, which the pod asks for,
//   allow `clone` only without any namespace flag (`CLONE_NEWUSER` among them), and `unshare` and
//   `setns` only with `CAP_SYS_ADMIN` (moby/profiles `seccomp/default.json`; containerd's
//   `contrib/seccomp/seccomp_default.go`, both read 2026-11-21). The agent's container drops every
//   capability but SETUID, SETGID and KILL.
// - `no-new-privileges` on `docker` and `allowPrivilegeEscalation: false` on `kubernetes` keep a
//   setuid helper from gaining anything, and the image doesn't install Debian's `chromium-sandbox`.
// Giving Chromium either (CAP_SYS_ADMIN, an unconfined or custom seccomp profile, a setuid helper)
// would loosen the box for every process in it, the agent's shell included. And what the sandbox
// guards is thin here: a page that broke out of its renderer would run as the agent's user in the
// agent's container, which is what the agent's own shell already is, with the box's network and
// no credential (ADR 0030, ADR 0031: "only a box contains the agent"). So the browser runs without
// its sandbox, inside the box's.
//
// **`/dev/shm` is 64 MiB in a container** (Docker's default `--shm-size`, and a pod's), which a
// large page fills, and the renderer crashes. `--disable-dev-shm-usage` puts Chromium's shared
// memory files in `/tmp` instead: the container's writable layer on `docker`, and the pod's
// in-memory `/tmp` volume on `kubernetes`, whose root file system is read-only.

export const CONTAINER_BROWSER_FLAGS: readonly string[] = ["--no-sandbox", "--disable-dev-shm-usage"];
