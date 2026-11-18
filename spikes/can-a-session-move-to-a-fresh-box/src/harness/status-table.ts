// A run's pass bar as a Markdown table, for README.md's status section.

import { statusOf, type Criterion } from "./report.ts";

const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");

export const statusTable = (run: string, bar: readonly Criterion[]): string => {
  const lines = [`Run \`${run}\`.`, "", "| | Status | Bullet | Checks |", "|---|---|---|---|"];
  for (const criterion of bar) {
    const status = statusOf(criterion.checks);
    const checks = criterion.checks.map((c) => `${c.status} ${cell(c.name)}: ${cell(c.note)}`).join("<br>");
    lines.push(`| ${criterion.id} | ${status === "PASS" ? status : `**${status}**`} | ${cell(criterion.title)} | ${checks} |`);
  }
  lines.push("", "Recorded:", "");
  for (const criterion of bar) {
    for (const [key, value] of Object.entries(criterion.recorded ?? {})) lines.push(`- ${criterion.id}, ${cell(key)}: ${cell(String(value))}`);
  }
  return `${lines.join("\n")}\n`;
};
