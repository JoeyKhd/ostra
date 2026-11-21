import type { DbEnum } from "@ostra/db";
import { runnerLimits } from "@ostra/protocol";

// F-145 (ADR 0069, ADR 0049, Q315, ticket 06): the skills and MCP servers a profile hands a task:
// its own, the library items attached to it, and the items on every profile, each library item at
// its current pin. Everything counts toward the limits of 50 skills and 20 servers, and a library
// item whose name the profile already uses for its own skill or server is refused. Each refusal
// names the profile, so an attach, or a switch to every profile, says which one it would break.
// Dispatch reads the list, and the profile's editor shows where each one comes from. Pure.

export const profileItemLimits = { skillsMax: runnerLimits.skillsMax, serversMax: runnerLimits.mcpServersMax } as const;

export type LibraryItemKind = DbEnum.LibraryItemKind;

/** A library item as the list takes it; `T` is what the caller carries along (its version, its files). */
export type ProfileLibraryItem<T> = { readonly itemId: string; readonly kind: LibraryItemKind; readonly name: string; readonly pinned: T };

/** The profile: its name, for the refusals, and its own skills' and servers' names. */
export type ProfileOwnItems = {
  readonly name: string;
  readonly skills: readonly { readonly name: string }[];
  readonly servers: readonly { readonly name: string }[];
};

/** Where an item on the list comes from. */
export type ProfileItemSource = "own" | "attached" | "every_profile";

export type ProfileItem<T> =
  | { readonly kind: LibraryItemKind; readonly name: string; readonly source: "own" }
  | { readonly kind: LibraryItemKind; readonly name: string; readonly source: "attached" | "every_profile"; readonly itemId: string; readonly pinned: T };

export type ProfileItemsRefusal = {
  readonly code: "too-many-skills" | "too-many-servers" | "name-taken";
  /** Names the profile. */
  readonly message: string;
  /** The library item that couldn't go on. */
  readonly itemId: string;
};

export type ProfileItems<T> =
  | { readonly ok: true; readonly skills: readonly ProfileItem<T>[]; readonly servers: readonly ProfileItem<T>[] }
  | { readonly ok: false; readonly refusal: ProfileItemsRefusal };

/**
 * The profile's list: its own items first, then those attached to it, then the every-profile
 * items, in the order given. An item both attached and on every profile is on the list once, as
 * attached. Refused at the first item that passes a limit or takes a name the profile uses.
 */
export const profileItems = <T,>(
  profile: ProfileOwnItems,
  attached: readonly ProfileLibraryItem<T>[],
  everyProfile: readonly ProfileLibraryItem<T>[],
): ProfileItems<T> => {
  const skills: ProfileItem<T>[] = profile.skills.map((skill) => ({ kind: "skill", name: skill.name, source: "own" }));
  const servers: ProfileItem<T>[] = profile.servers.map((server) => ({ kind: "mcp_server", name: server.name, source: "own" }));
  const ownNames = { skill: new Set(profile.skills.map((skill) => skill.name)), mcp_server: new Set(profile.servers.map((server) => server.name)) };
  const seen = new Set<string>();
  const library = [...attached.map((item) => ({ item, source: "attached" as const })), ...everyProfile.map((item) => ({ item, source: "every_profile" as const }))];
  for (const { item, source } of library) {
    if (seen.has(item.itemId)) {
      continue;
    }
    seen.add(item.itemId);
    const noun = item.kind === "skill" ? "skill" : "MCP server";
    if (ownNames[item.kind].has(item.name)) {
      return { ok: false, refusal: { code: "name-taken", itemId: item.itemId, message: `The profile ${profile.name} already has its own ${noun} named ${item.name}` } };
    }
    const list = item.kind === "skill" ? skills : servers;
    const max = item.kind === "skill" ? profileItemLimits.skillsMax : profileItemLimits.serversMax;
    if (list.length >= max) {
      return {
        ok: false,
        refusal: {
          code: item.kind === "skill" ? "too-many-skills" : "too-many-servers",
          itemId: item.itemId,
          message: `The profile ${profile.name} would have more than ${String(max)} ${noun}s, the most a profile hands a task`,
        },
      };
    }
    list.push({ kind: item.kind, name: item.name, source, itemId: item.itemId, pinned: item.pinned });
  }
  return { ok: true, skills, servers };
};
