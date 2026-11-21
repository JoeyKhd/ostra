// A task's previews, what a preview may reach, and the in-box addresses (milestone 8, F-140, F-141,
// ADR 0068). The rules are the protocol's (`task/previews.ts`), so the runner, which sends
// `preview.list` and sets the addresses, and core, which checks a view, apply one rule: the runner
// may not import the domain (the license line, ADR 0045). The domain names them here as before.

export { appAddresses, inBoxServiceAddress, mayReach, previewTargets } from "@ostra/protocol";
export type { AddressService, AnnouncedPreview, PreviewEnvironment, PreviewProcess, PreviewService, Reach, ReachRefusal } from "@ostra/protocol";
