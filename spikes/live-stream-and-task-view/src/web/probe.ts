// The browser-latency probe, on only when the page is opened with `?probe=latency`. The latency check's
// events carry the time they were emitted in their text (`lat:<ms>:<n>`). A MutationObserver watches the
// page's DOM, and for every such stamp it sees for the first time it records how long ago it was emitted:
// the time from the runner to a row being in the DOM (a React commit later than the 16 ms flush timer and the
// fold, but before the browser paints it).
const STAMP = /lat:(\d{13}):(\d+)/g;

const samples: number[] = [];
const seen = new Set<string>();

const scan = (text: string): void => {
  const now = Date.now();
  for (const match of text.matchAll(STAMP)) {
    const emittedAt = Number(match[1]);
    const key = match[2] ?? "";
    if (seen.has(key)) continue;
    seen.add(key);
    samples.push(Math.max(0, now - emittedAt));
  }
};

export const startLatencyProbe = (): void => {
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") scan(mutation.target.textContent ?? "");
      for (const node of mutation.addedNodes) scan(node.textContent ?? "");
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
};

export const latencies = (): number[] => [...samples];
