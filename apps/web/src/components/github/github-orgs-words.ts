import { plural, t } from "@/lib/messages";

// The words of Organization › GitHub with several GitHub organizations (F-136). Pure.

type Installation = {
  readonly accountLogin: string;
  readonly state: "linked" | "waiting" | "suspended" | "removed";
  readonly isOwner: boolean;
  readonly repoSelection: "all" | "selected" | null;
  readonly repos: readonly unknown[];
};

const stateOrder: Readonly<Record<Installation["state"], number>> = { linked: 0, waiting: 1, suspended: 2, removed: 3 };

/** Linked (the owner's own first), waiting, suspended, removed; by login within each. */
export const orderInstallations = <T extends Installation,>(installations: readonly T[]): readonly T[] =>
  [...installations].sort((a, b) => {
    const byState = stateOrder[a.state] - stateOrder[b.state];
    if (byState !== 0) return byState;
    const own = Number(b.isOwner) - Number(a.isOwner);
    return own !== 0 ? own : a.accountLogin.localeCompare(b.accountLogin);
  });

/**
 * `All repositories`, `1 repository`, `2 repositories`; `Selected repositories` while ostra may not
 * list them (a waiting installation's repos are offered nowhere), `–` when GitHub no longer lists it.
 */
export const reposText = (installation: Pick<Installation, "repoSelection" | "repos">): string =>
  installation.repoSelection === "all"
    ? t("githubOrgs.allRepos")
    : installation.repos.length > 0
      ? plural(installation.repos.length, "githubOrgs.reposOne", "githubOrgs.reposMany")
      : installation.repoSelection === "selected"
        ? t("githubOrgs.selectedRepos")
        : "–";

/** The App's install page, without the scheme, as the panel shows it. */
export const installUrl = (slug: string): string => `github.com/apps/${slug}/installations/new`;

/** An App's settings on GitHub, a user's own or an organization's: its General page holds its client secrets (Q295). */
export const appGeneralSettingsUrl = (slug: string, owner: { readonly login: string; readonly kind: "organization" | "user" }): string =>
  owner.kind === "user" ? `https://github.com/settings/apps/${slug}` : `https://github.com/organizations/${owner.login}/settings/apps/${slug}`;

/** GitHub's "Danger zone" for an App: a user's own, or an organization's. */
export const appSettingsUrl = (slug: string, owner: { readonly login: string; readonly kind: "organization" | "user" }): string => `${appGeneralSettingsUrl(slug, owner)}/advanced`;

/** `3 Nov`. */
export const dayMonth = (at: number): string => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * Whether the panel treats an App as public, private, or not known (F-136). GitHub doesn't tell an
 * App's visibility: the API reports `public: true` once the App is installed on an account other
 * than its owner's, and `null` otherwise. An App is private by default, so one with a known owner
 * and no such install is private: it gets the Private Apps group, with GitHub's own setting. One
 * whose owner isn't known yet is offered for installing, so the panel never says it "stays on" an
 * owner it can't name.
 */
export const appVisibility = (app: { readonly public: boolean | null; readonly ownerLogin: string | null }): "public" | "private" | "unknown" =>
  app.public === true ? "public" : app.ownerLogin === null ? "unknown" : "private";
