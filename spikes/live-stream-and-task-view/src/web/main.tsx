import { createRoot } from "react-dom/client";
import { MemberId, TaskId } from "../shared/ids.ts";
import { api } from "./api.ts";
import { startLatencyProbe } from "./probe.ts";
import { TaskPage } from "./task-page.tsx";
import "./styles.css";

// The task ID from /task/<id>, or null when the path has none or it is not a usable ID (a stray `%`
// makes decodeURIComponent throw, and the page must not die at boot over a bad URL).
const taskIdFromPath = (pathname: string): TaskId | null => {
  const raw = pathname.split("/")[2];
  if (raw === undefined || raw.length === 0) return null;
  try {
    const parsed = TaskId.safeParse(decodeURIComponent(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

// Dev stand-in for sign-in: ?as=<memberId> logs that member in (better-auth replaces it in the product).
const boot = async (): Promise<void> => {
  const params = new URLSearchParams(window.location.search);
  const root = document.getElementById("root");
  if (root === null) return;
  const as = MemberId.safeParse(params.get("as") ?? undefined);
  if (as.success) await api.login(as.data);
  if (params.get("probe") === "latency") startLatencyProbe();
  const taskId = taskIdFromPath(window.location.pathname);
  if (taskId === null) {
    root.textContent = "Open /task/<id>?as=<member>";
    return;
  }
  createRoot(root).render(<TaskPage taskId={taskId} turns={params.get("turns") ?? "20"} />);
};

void boot();
