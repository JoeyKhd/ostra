// One colour per project, only on its 8px square (app-design.md). Picked from the ID, so every
// viewer sees the same colour without storing one.
const palette = ["#6FB8AA", "#8C7CF0", "#E0A458", "#5FA8E8", "#C27BA0", "#9DBF6B", "#D9826B", "#7FA3C9"] as const;

export const projectColour = (id: string): string => {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length] ?? palette[0];
};
