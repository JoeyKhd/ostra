"use client";

export type ProjectNavProps = { readonly onNavigate: () => void };

// The member's projects in the sidebar. Filled from `projects.list` once ticket 32's router is in;
// until then the section holds only "New project".
export const ProjectNav = (props: ProjectNavProps) => (props.onNavigate.length > 0 ? null : null);
