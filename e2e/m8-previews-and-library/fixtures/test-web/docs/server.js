import { createServer } from "node:http";

// The app's docs, on 4000: a third process with a page of its own, a preview beside the frontend's.
const port = Number(process.env["TEST_WEB_DOCS_PORT"] ?? "4000");

const page = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>test-web docs</title></head>
  <body><h1>test-web docs</h1><p>The counter counts. The footer shows the API's version.</p></body>
</html>`;

createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(page);
}).listen(port, "localhost", () => {
  console.log(`docs listening on ${String(port)}`);
});
