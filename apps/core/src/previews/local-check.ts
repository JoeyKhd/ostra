import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { checkPreviewDomain, createPreviewDomainProbe, previewCheckMark, previewDomainStatus, savePreviewDomainCheck } from "@ostra/domain";
import type { AuditLog, Clock, PreviewDomainProbe, PreviewSettings } from "@ostra/domain";

// A one-machine install's preview domain, checked by core itself (ADR 0068, the lead, 2026-11-21):
// with OSTRA_PREVIEW_DOMAIN unset and the panel and core on loopback, the domain is
// `preview.localhost` (`resolvePreviewDomain`), and core runs Instance › Previews' check once it
// listens, so the pane opens a preview in the member's own browser with no admin pressing "Check
// again". It's the same check (core's mark on `/.ostra/check` and an upgrade, on core's public port),
// kept for the install and audited as the system.
//
// It runs only:
// - for the default: a domain an admin set stays theirs to check, since its record or its
//   certificate may not be in place when core starts;
// - when core's public port is the one it listens on, so it never asks another program on this
//   machine (another install, a test's core on its own port);
// - when the last result for the domain isn't a pass: a restart doesn't check again.

export type LocalPreviewCheck =
  | { readonly kind: "skipped"; readonly why: "not-the-default" | "another-port" | "passed-before" }
  | { readonly kind: "checked"; readonly passed: boolean };

export type LocalPreviewCheckDeps = {
  readonly db: Db;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The secrets key's text: core's proxy marks its check answer with it. */
  readonly secret: () => Promise<string>;
  /** Node's own by default (`*.localhost` on loopback); a fake in tests. */
  readonly probe?: PreviewDomainProbe;
};

/** The port a URL names, or its scheme's. */
const portOf = (url: URL): number => (url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port));

export const checkLocalPreviewDomain = async (
  deps: LocalPreviewCheckDeps,
  input: { readonly previews: Pick<PreviewSettings, "domain" | "localDefault">; readonly corePublicUrl: string; readonly port: number },
): Promise<LocalPreviewCheck> => {
  const domain = input.previews.domain;
  if (!input.previews.localDefault || domain === null) {
    return { kind: "skipped", why: "not-the-default" };
  }
  if (portOf(new URL(input.corePublicUrl)) !== input.port) {
    deps.logger.info("preview.domain-check-skipped", { why: "another-port", port: input.port });
    return { kind: "skipped", why: "another-port" };
  }
  const status = await previewDomainStatus(deps.db, domain);
  if (status.state === "checked" && status.passed) {
    return { kind: "skipped", why: "passed-before" };
  }
  const secret = await deps.secret();
  const check = await checkPreviewDomain(
    { probe: deps.probe ?? createPreviewDomainProbe(), mark: (host) => previewCheckMark(secret, host), clock: deps.clock },
    { domain, corePublicUrl: input.corePublicUrl },
  );
  await savePreviewDomainCheck({ db: deps.db, audit: deps.audit, clock: deps.clock }, { kind: "system" }, { domain, check });
  const passed = check.state === "checked" && check.passed;
  deps.logger.info("preview.domain-checked", { by: "system", passed });
  return { kind: "checked", passed };
};
