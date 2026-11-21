import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import type { ServerResponse } from "node:http";

// The viewer page, served to the member's browser: a canvas that draws the stream's frames and sends the
// member's input back. viewer.ts is typed like the rest of the spike and served with its types stripped.

const viewerHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Preview</title>
    <link rel="icon" href="data:," />
    <style>
      html, body { margin: 0; background: #111; overflow: hidden; }
      canvas { display: block; outline: none; cursor: default; }
    </style>
  </head>
  <body>
    <canvas id="screen" tabindex="0" width="1" height="1"></canvas>
    <script type="module" src="./viewer.js"></script>
  </body>
</html>`;

let viewerJs: string | null = null;

export const serveViewer = async (path: string, response: ServerResponse): Promise<boolean> => {
  if (path === "/viewer") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(viewerHtml);
    return true;
  }
  if (path === "/viewer.js") {
    viewerJs ??= stripTypeScriptTypes(await readFile(new URL("../viewer/viewer.ts", import.meta.url), "utf8"));
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    response.end(viewerJs);
    return true;
  }
  return false;
};
