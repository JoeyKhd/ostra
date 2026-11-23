import { projectColour } from "@/components/shell/project-colour";
import { t } from "@/lib/messages";

import type { TrackerItem } from "./tracker-words";

// A connection's boards in its properties panel (`Boards on it`, connection-settings.md): the
// project's square, the project, and the board with its key at the right. Both kinds use it.

export const ConnectionBoards = ({ boards }: { readonly boards: TrackerItem["boards"] }) =>
  boards.length === 0 ? (
    <p className="py-1 text-sm text-faint" data-testid="connection-boards">
      {t("trackers.linear.panel.noBoards")}
    </p>
  ) : (
    <ul data-testid="connection-boards">
      {boards.map((board) => (
        <li key={board.id} className="flex h-7 items-center gap-[9px] whitespace-nowrap text-ui">
          <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(board.project.id) }} />
          <span className="min-w-0 truncate text-text">{board.project.name}</span>
          <span className="ml-auto min-w-0 truncate pl-2 font-mono text-[12.5px] text-faint">{board.key ?? board.name}</span>
        </li>
      ))}
    </ul>
  );
