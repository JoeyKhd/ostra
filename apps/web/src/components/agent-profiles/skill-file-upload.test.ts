import { describe, expect, it } from "vitest";

import { SKILL_FILE_UPLOAD_PATH, uploadSkillFile } from "./skill-file-upload";

// F-021 (ticket 42): a skill's file goes up the moment it is picked. The route's answer becomes the
// draft's file, and a refusal becomes a message the Sheet shows.

const BLOB = "01900000-0000-7000-8000-0000000000ee";
const file = (text: string, name = "example.txt"): File => new File([text], name, { type: "text/plain" });

describe("uploading a skill's file", () => {
  it("F-021: sends the file's bytes as application/octet-stream to the panel's route, and keeps the blob core stored", async () => {
    let seen: { url: string; type: string | null; body: string } | undefined;
    const send: typeof fetch = async (input, init) => {
      const request = new Request(new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input, "http://panel.test"), init);
      seen = { url: request.url, type: request.headers.get("content-type"), body: await request.text() };
      return Response.json({ blobId: BLOB, size: 12 });
    };
    const sent = await uploadSkillFile(file("hello world!", "examples/one.md"), send);
    expect(seen).toEqual({ url: `http://panel.test${SKILL_FILE_UPLOAD_PATH}`, type: "application/octet-stream", body: "hello world!" });
    expect(sent).toEqual({ ok: true, file: { path: "examples/one.md", size: 12, blobId: BLOB } });
  });

  it("F-021/c1: a 413 says the file is over the limit, and any other failure says to try again; nothing is added", async () => {
    expect(await uploadSkillFile(file("x"), () => Promise.resolve(Response.json({ error: "big" }, { status: 413 })))).toEqual({ ok: false, key: "agentProfiles.skill.errorSize" });
    expect(await uploadSkillFile(file("x"), () => Promise.resolve(Response.json({ error: "down" }, { status: 503 })))).toEqual({ ok: false, key: "agentProfiles.skill.errorUpload" });
    expect(await uploadSkillFile(file("x"), () => Promise.resolve(Response.json({ surprise: true })))).toEqual({ ok: false, key: "agentProfiles.skill.errorUpload" });
    expect(await uploadSkillFile(file("x"), () => Promise.reject(new Error("offline")))).toEqual({ ok: false, key: "agentProfiles.skill.errorUpload" });
  });
});
