import { taskIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";
import { describeUpstreamRefusal } from "./git-proxy.ts";
import { isAllowedLfsActionHref } from "./lfs.ts";
import { emptyReceivePackAdvertisement, encodePkt, encodeRefusal, FLUSH_PKT, parseReceivePackHead, readPkt } from "./pkt-line.ts";
import type { RefUpdateCommand } from "./pkt-line.ts";
import { decidePush } from "./policy.ts";
import type { TaskGitPolicy } from "./policy.ts";

// The git proxy's pure parts. Ported from spikes/github-app-and-git-proxy/test/ (pkt-line, policy,
// lfs-action-href).

const A = "a".repeat(40);
const B = "b".repeat(40);
const Z = "0".repeat(40);

const body = (...lines: string[]): Buffer => Buffer.concat([...lines.map((line) => encodePkt(line)), FLUSH_PKT, Buffer.from("PACK...")]);

describe("pkt-line", () => {
  it("parses the command list and stops at the flush, before the pack", () => {
    const buffer = body(`${A} ${B} refs/heads/ostra/t1\0report-status side-band-64k agent=git/2.53\n`, `${Z} ${B} refs/ostra/wip/t1\n`);
    const parsed = parseReceivePackHead(buffer);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") {
      return;
    }
    expect(parsed.head.commands.map((command) => [command.ref, command.kind])).toEqual([
      ["refs/heads/ostra/t1", "update"],
      ["refs/ostra/wip/t1", "create"],
    ]);
    expect(parsed.head.capabilities).toEqual(["report-status", "side-band-64k", "agent=git/2.53"]);
    expect(buffer.subarray(parsed.head.headLength).toString()).toBe("PACK...");
  });

  it("asks for more bytes when the list is split across chunks", () => {
    const buffer = body(`${A} ${B} refs/heads/x\0report-status\n`);
    expect(parseReceivePackHead(buffer.subarray(0, 30)).kind).toBe("need-more");
    expect(parseReceivePackHead(buffer.subarray(0, 2)).kind).toBe("need-more");
  });

  it("recognises deletes, shallow lines and the empty probe", () => {
    const deleted = parseReceivePackHead(body(`shallow ${A}\n`, `${A} ${Z} refs/heads/main\0report-status\n`));
    expect(deleted.kind === "parsed" ? deleted.head.commands[0]?.kind : null).toBe("delete");
    expect(deleted.kind === "parsed" ? deleted.head.shallow.length : null).toBe(1);
    const probe = parseReceivePackHead(FLUSH_PKT);
    expect(probe.kind === "parsed" ? probe.head.commands.length : null).toBe(0);
  });

  it("fails closed on malformed input and signed pushes", () => {
    expect(parseReceivePackHead(Buffer.from("zzzz")).kind).toBe("error");
    expect(parseReceivePackHead(Buffer.from("0003")).kind).toBe("error");
    expect(parseReceivePackHead(body("not a command\n")).kind).toBe("error");
    expect(parseReceivePackHead(body(`${A} nothex refs/heads/x\n`)).kind).toBe("error");
    expect(parseReceivePackHead(body("push-cert\0report-status\n")).kind).toBe("error");
    expect(parseReceivePackHead(body(`${Z} ${Z} refs/heads/x\n`)).kind).toBe("error");
  });

  it("encodes a refusal git can print, in side-band when asked, and none without report-status", () => {
    const parsed = parseReceivePackHead(body(`${A} ${B} refs/heads/main\0report-status side-band-64k\n`));
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") {
      return;
    }
    const out = encodeRefusal(parsed.head, () => "ostra: no", "ostra: refused");
    expect(out).not.toBeNull();
    if (out === null) {
      return;
    }
    const first = readPkt(out, 0);
    expect(first.kind === "packet" && first.packet.kind === "data" ? first.packet.payload[0] : null).toBe(2);
    expect(out.toString("utf8")).toContain("ng refs/heads/main ostra: no");
    const plain = parseReceivePackHead(body(`${A} ${B} refs/heads/main\0\n`));
    expect(plain.kind === "parsed" ? encodeRefusal(plain.head, () => "x", "x") : "unparsed").toBeNull();
  });

  it("advertises an empty repo that git can push to", () => {
    const advertisement = emptyReceivePackAdvertisement("ostra-git-proxy/0");
    expect(advertisement.toString("utf8")).toContain("# service=git-receive-pack");
    expect(advertisement.toString("utf8")).toContain("capabilities^{}\0report-status");
  });
});

describe("the push policy", () => {
  const policy: TaskGitPolicy = { taskId: taskIdSchema.parse("t1"), branch: "ostra/t1", mode: "read-write" };
  const command = (ref: string, kind: RefUpdateCommand["kind"] = "update"): RefUpdateCommand => ({ oldId: A, newId: B, ref, kind });

  it("allows the task's branch and hidden ref", () => {
    expect(decidePush(policy, [command("refs/heads/ostra/t1"), command("refs/ostra/wip/t1", "create")]).allowed).toBe(true);
  });

  it("F-066: allows a repo's own branch instead of the task's, and the hidden ref beside either", () => {
    expect(decidePush(policy, [command("refs/heads/ostra/t1-2"), command("refs/ostra/wip/t1", "create")], "ostra/t1-2").allowed).toBe(true);
    // The task's branch is not that repo's: it can't be pushed there, and nothing else can.
    expect(decidePush(policy, [command("refs/heads/ostra/t1")], "ostra/t1-2").allowed).toBe(false);
    expect(decidePush(policy, [command("refs/heads/ostra/t1-2")]).allowed).toBe(false);
  });

  it("refuses everything else, exactly", () => {
    for (const ref of ["refs/heads/main", "refs/heads/ostra/t1-evil", "refs/heads/OSTRA/t1", "refs/tags/v1", "refs/ostra/wip/t2", "refs/heads/ostra/t1/x"]) {
      expect(decidePush(policy, [command(ref)]).allowed, ref).toBe(false);
    }
  });

  it("refuses deletes, even of its own branch", () => {
    const verdict = decidePush(policy, [command("refs/heads/ostra/t1", "delete")]);
    expect(verdict.allowed ? [] : verdict.codes).toEqual(["delete"]);
  });

  it("refuses the whole push for one bad ref", () => {
    const verdict = decidePush(policy, [command("refs/heads/ostra/t1"), command("refs/heads/main")]);
    expect(verdict.allowed).toBe(false);
    expect(verdict.verdicts.map((item) => item.allowed)).toEqual([false, false]);
  });

  it("refuses every update when read-only", () => {
    expect(decidePush({ ...policy, mode: "read-only" }, [command("refs/heads/ostra/t1")]).allowed).toBe(false);
  });
});

describe("LFS action hosts", () => {
  const github = ["github-cloud.githubusercontent.com", "github-cloud.s3.amazonaws.com", "lfs.github.com"];
  const allowed = (href: string, hosts: readonly string[] = github): boolean => isAllowedLfsActionHref(new URL(href), "https://github.com", hosts);

  it("allows the upstream's origin and the listed storage hosts", () => {
    expect(allowed("https://github.com/o/r.git/info/lfs/objects/abc")).toBe(true);
    expect(allowed("https://github-cloud.githubusercontent.com/alambic/media/1")).toBe(true);
    expect(allowed("https://github-cloud.s3.amazonaws.com/alambic/media/1")).toBe(true);
    expect(allowed("https://lfs.github.com/o/r/objects/abc/verify")).toBe(true);
  });

  it("refuses other buckets, look-alikes, IP literals, localhost, other schemes and ports", () => {
    for (const href of [
      "https://evil.s3.amazonaws.com/x",
      "https://s3.amazonaws.com/evil/x",
      "https://github-cloud.s3.amazonaws.com.evil.example/x",
      "https://evil.lfs.github.com/x",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/x",
      "https://127.0.0.1/x",
      "https://localhost/x",
      "https://api.localhost/x",
      "http://github-cloud.githubusercontent.com/x",
      "https://github-cloud.githubusercontent.com:8443/x",
      "https://user:pass@github-cloud.githubusercontent.com/x",
    ]) {
      expect(allowed(href), href).toBe(false);
    }
  });

  it("allows a configured host, and only it", () => {
    expect(allowed("https://lfs.ghes.example.com/x", ["lfs.ghes.example.com"])).toBe(true);
    expect(allowed("https://github-cloud.githubusercontent.com/x", ["lfs.ghes.example.com"])).toBe(false);
  });
});

describe("refusal words", () => {
  it("F-090: words an upstream refusal by its status and by who refused", () => {
    expect(describeUpstreamRefusal(401, "code-host")).toBe("ostra: the code host refused the task's credential (status 401)");
    expect(describeUpstreamRefusal(403, "code-host")).toBe("ostra: the code host refused the task's credential (status 403)");
    expect(describeUpstreamRefusal(403, "lfs-host")).toBe("ostra: the LFS storage host refused the transfer (status 403)");
    expect(describeUpstreamRefusal(404, "code-host")).toBe("ostra: the code host has no such repo, or the App can't see it (status 404)");
    expect(describeUpstreamRefusal(404, "lfs-host")).toBe("ostra: the LFS storage host has no such object (status 404)");
    expect(describeUpstreamRefusal(302, "lfs-host")).toBe(
      "ostra: the LFS storage host answered with a redirect or a proxy challenge (status 302), which the proxy doesn't follow",
    );
    expect(describeUpstreamRefusal(407, "code-host")).toContain("the code host answered with a redirect or a proxy challenge (status 407)");
    expect(describeUpstreamRefusal(500, "code-host")).toBe("ostra: the code host answered 500");
    expect(describeUpstreamRefusal(503, "lfs-host")).toBe("ostra: the LFS storage host answered 503");
  });
});
