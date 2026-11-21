import { message } from "./message.js";

// webpack's own HMR: an edit to message.js is accepted here and re-rendered without a reload.
const render = (text) => {
  document.getElementById("message").textContent = text;
};
render(message);
if (import.meta.webpackHot) {
  import.meta.webpackHot.accept("./message.js", () => {
    import("./message.js").then((module) => render(module.message));
  });
}
