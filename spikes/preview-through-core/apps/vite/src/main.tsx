import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";

// The entry renders App from its own module, so an edit under it is a React Fast Refresh update, not a reload.
const root = document.getElementById("root");
if (root === null) throw new Error("no #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
