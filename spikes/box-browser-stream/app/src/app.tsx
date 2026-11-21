import { useEffect, useState } from "react";

// Eight probe squares in the top-left corner, which the viewer reads from the decoded frames to time input:
// the first four are the count of pointerdowns on the counter, mod 16, in binary; the next four the count of
// keydowns in the page. They are part of the app only for the spike; a real app has none.
type ApiState = { readonly kind: "loading" } | { readonly kind: "ok"; readonly text: string } | { readonly kind: "failed"; readonly text: string };

const rows = Array.from({ length: 400 }, (_, index) => ({
  id: index,
  title: `Row ${String(index + 1)}: a card with a title, a line of text and a badge`,
  body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.",
  badge: ["open", "review", "merged", "closed"][index % 4] ?? "open",
}));

const readHello = async (): Promise<string> => {
  const response = await fetch("/api/hello");
  if (!response.ok) throw new Error(`status ${String(response.status)}`);
  const body: unknown = await response.json();
  if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") return body.message;
  throw new Error("unexpected body");
};

export const App = () => {
  const [count, setCount] = useState(0);
  const [presses, setPresses] = useState(0);
  const [keys, setKeys] = useState(0);
  const [text, setText] = useState("");
  // A spinner the harness turns on to measure a page that changes every frame (window.__animate(true)).
  const [animating, setAnimating] = useState(false);
  useEffect(() => {
    Reflect.set(window, "__animate", setAnimating);
  }, []);
  const [api, setApi] = useState<ApiState>({ kind: "loading" });

  useEffect(() => {
    readHello().then(
      (message) => {
        setApi({ kind: "ok", text: message });
      },
      (error: unknown) => {
        setApi({ kind: "failed", text: error instanceof Error ? error.message : "failed" });
      },
    );
  }, []);

  useEffect(() => {
    const onKey = () => {
      setKeys((value) => value + 1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  const apiText = api.kind === "loading" ? "api: loading" : api.kind === "ok" ? `api: ok, ${api.text}` : `api: failed, ${api.text}`;

  return (
    <>
      <div className="probe" aria-hidden="true">
        {[0, 1, 2, 3].map((bit) => (
          <div key={`a${String(bit)}`} className={((presses >> bit) & 1) === 1 ? "on" : "off"} />
        ))}
        {[0, 1, 2, 3].map((bit) => (
          <div key={`b${String(bit)}`} className={((keys >> bit) & 1) === 1 ? "on" : "off"} />
        ))}
      </div>
      <div id="spinner" className={animating ? "spinning" : ""} aria-hidden="true">
      </div>
      <header>
        <h1>Spike app</h1>
        <p id="api" className={api.kind}>
          {apiText}
        </p>
      </header>
      <main>
        <section className="controls">
          <button
            id="counter"
            type="button"
            onPointerDown={() => {
              setPresses((value) => value + 1);
            }}
            onClick={() => {
              setCount((value) => value + 1);
            }}
          >
            Count: <span id="count">{count}</span>
          </button>
          <input
            id="field"
            type="text"
            placeholder="Type here"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
        </section>
        <ul className="rows">
          {rows.map((row) => (
            <li key={row.id}>
              <div className="title">{row.title}</div>
              <div className="body">{row.body}</div>
              <span className={`badge ${row.badge}`}>{row.badge}</span>
            </li>
          ))}
        </ul>
      </main>
    </>
  );
};
