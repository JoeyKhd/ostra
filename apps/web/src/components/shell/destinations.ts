import { t } from "@/lib/messages";

// The places search ⌘K can open (milestone 1: the sidebar's own pages, nothing else). Pure, so the
// list and its filter are tested without a browser.

export type DestinationIcon = "home" | "new-task" | "project" | "tasks" | "environment" | "new-project" | "runners" | "models" | "github";

export type Destination = {
  readonly href: string;
  readonly label: string;
  /** Where it sits, in `--faint` after the label: the project's name for its pages. */
  readonly context?: string;
  readonly icon: DestinationIcon;
  /** The project's colour square, for a project row. */
  readonly colour?: string;
};

export type DestinationProject = { readonly id: string; readonly name: string; readonly colour: string };

export const destinations = (projects: readonly DestinationProject[], admin: boolean): readonly Destination[] => [
  { href: "/", label: t("shell.home"), icon: "home" },
  { href: "/tasks/new", label: t("shell.newTask"), icon: "new-task" },
  ...projects.flatMap((project): Destination[] => [
    { href: `/projects/${project.id}`, label: project.name, icon: "project", colour: project.colour },
    { href: `/projects/${project.id}`, label: t("shell.tasks"), context: project.name, icon: "tasks" },
    { href: `/projects/${project.id}/environment`, label: t("shell.environment"), context: project.name, icon: "environment" },
  ]),
  ...(admin ? [{ href: "/projects/new", label: t("shell.newProject"), icon: "new-project" } satisfies Destination] : []),
  { href: "/organization/runners", label: t("shell.runners"), icon: "runners" },
  ...(admin
    ? [
        { href: "/organization/models", label: t("shell.models"), icon: "models" } satisfies Destination,
        { href: "/organization/github", label: t("shell.github"), icon: "github" } satisfies Destination,
      ]
    : []),
];

/**
 * The destinations whose words contain every word of the query, in their order. An empty query
 * keeps them all.
 */
export const matchDestinations = (list: readonly Destination[], query: string): readonly Destination[] => {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return list;
  return list.filter((destination) => {
    const haystack = `${destination.label} ${destination.context ?? ""}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
};
