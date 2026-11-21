import { useEffect, useState } from "react";
import { message } from "./message.ts";

// The page: a message the harness edits to see HMR, and the frontend's /api call through Vite's proxy.
export const App = () => {
  const [api, setApi] = useState("api: loading");
  useEffect(() => {
    fetch("/api/hello")
      .then(async (response) => {
        const body: unknown = await response.json();
        const text = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : "unexpected";
        setApi(`api: ok, ${text}`);
      })
      .catch(() => {
        setApi("api: failed");
      });
  }, []);
  return (
    <main>
      <h1 id="message">{message}</h1>
      <p id="api">{api}</p>
    </main>
  );
};
