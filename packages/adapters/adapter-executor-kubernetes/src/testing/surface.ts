import { z } from "zod";

import type { FakeKubeApi, KubeObject } from "./fake-api.ts";

// What a box's containers see, read back from the fake Kubernetes API (ticket 07): for the tests of
// F-015 (the task token reaches the sidecar's mount only) and F-120 (the pull credential reaches no
// container). Test and dev only.

const recordSchema = z.record(z.string(), z.unknown());
export const recordOf = (value: unknown): Record<string, unknown> => recordSchema.safeParse(value).data ?? {};
export const arrayOf = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value) ? value.flatMap((item) => { const parsed = recordSchema.safeParse(item); return parsed.success ? [parsed.data] : []; }) : [];

/** A secret's data, decoded, as the API stores it. */
export const fakeSecretData = (fake: FakeKubeApi, namespace: string, name: string): Record<string, string> => {
  const data = recordOf(fake.get("secrets", namespace, name)?.["data"]);
  return Object.fromEntries(Object.entries(data).flatMap(([key, value]) => (typeof value === "string" ? [[key, Buffer.from(value, "base64").toString("utf8")]] : [])));
};

/** The place the sidecar's task token is meant to be: left out of the surface's checks by name. */
export const SIDECAR_TOKEN_MOUNT = "sidecar:token-mount";

/**
 * Everything each container of a pod sees, as text, by place: its command and arguments, each
 * variable as resolved (a secret key's value included), and each file of every secret volume it
 * mounts. The sidecar's token mount is named `SIDECAR_TOKEN_MOUNT`.
 */
export const podSurface = (fake: FakeKubeApi, namespace: string, pod: KubeObject): { readonly where: string; readonly text: string }[] => {
  const spec = recordOf(pod["spec"]);
  const volumes = arrayOf(spec["volumes"]);
  const places: { where: string; text: string }[] = [];
  for (const container of [...arrayOf(spec["initContainers"]), ...arrayOf(spec["containers"])]) {
    const name = String(container["name"]);
    places.push({ where: `${name}: command and arguments`, text: JSON.stringify([container["command"], container["args"]]) });
    for (const variable of arrayOf(container["env"])) {
      const ref = recordOf(recordOf(variable["valueFrom"])["secretKeyRef"]);
      const value =
        typeof variable["value"] === "string"
          ? variable["value"]
          : typeof ref["name"] === "string" && typeof ref["key"] === "string"
            ? (fakeSecretData(fake, namespace, ref["name"])[ref["key"]] ?? "")
            : "";
      places.push({ where: `${name}: variable ${String(variable["name"])}`, text: value });
    }
    for (const from of arrayOf(container["envFrom"])) {
      const ref = recordOf(from["secretRef"]);
      places.push({ where: `${name}: envFrom`, text: JSON.stringify(typeof ref["name"] === "string" ? fakeSecretData(fake, namespace, ref["name"]) : {}) });
    }
    for (const mount of arrayOf(container["volumeMounts"])) {
      const volume = volumes.find((each) => each["name"] === mount["name"]);
      const secretRef = recordOf(volume?.["secret"]);
      if (typeof secretRef["secretName"] !== "string") continue;
      const data = fakeSecretData(fake, namespace, secretRef["secretName"]);
      const items = arrayOf(secretRef["items"]);
      const keys = items.length > 0 ? items.map((item) => String(item["key"])) : Object.keys(data);
      const isTokenMount = name === "sidecar" && mount["name"] === "token";
      places.push({ where: isTokenMount ? SIDECAR_TOKEN_MOUNT : `${name}: volume ${String(mount["name"])}`, text: keys.map((key) => data[key] ?? "").join("\n") });
    }
  }
  return places;
};

/** The names of a kind's objects that carry a label. */
export const namesWithLabel = (fake: FakeKubeApi, resource: "pods" | "secrets", namespace: string, key: string, value: string): string[] =>
  fake
    .list(resource, namespace)
    .filter((item) => recordOf(recordOf(item["metadata"])["labels"])[key] === value)
    .map((item) => String(recordOf(item["metadata"])["name"]));
