import { useEffect, useState } from "react";

// The page the box's browser, the pane and the screenshots show: a counter to click, a field to
// type in, the API's answer through the frontend's own /api (the one-origin convention), and the
// WebSocket echo through the same proxy. A test reads each by its id.
export const App = () => {
  const [count, setCount] = useState(0);
  const [text, setText] = useState("");
  const [api, setApi] = useState("loading");
  const [version, setVersion] = useState(null);
  const [echo, setEcho] = useState("not yet");

  useEffect(() => {
    fetch("/api/hello")
      .then((response) => response.json())
      .then((body) => setApi(`api: ok, ${body.message}`))
      .catch(() => setApi("api: unreachable"));
    fetch("/api/version")
      .then((response) => response.json())
      .then((body) => setVersion(body.version))
      .catch(() => setVersion(null));
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);
    socket.addEventListener("open", () => socket.send("ping through the proxy"));
    socket.addEventListener("message", (event) => setEcho(String(event.data)));
    socket.addEventListener("error", () => setEcho("echo: unreachable"));
    return () => socket.close();
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>test-web</h1>
      <button id="counter" type="button" onClick={() => setCount((value) => value + 1)}>
        Count: {count}
      </button>
      <p>
        <input id="field" aria-label="Type here" value={text} onChange={(event) => setText(event.target.value)} />
        <span id="typed">{text}</span>
      </p>
      <p id="api">{api}</p>
      <p id="echo">{echo}</p>
      <p>
        <a href="/frame-deny">A page that refuses framing</a> · <a href="/host-url">A page that builds a URL from its host</a>
      </p>
      <footer id="footer">{version === null ? "API version unknown" : `API version ${version}`}</footer>
    </main>
  );
};
