// Testserver: serveert public/ (inclusief de echte nummerlijst in public/data) met de CSP uit _headers.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve("public");
const headersFile = fs.readFileSync(path.join(root, "_headers"), "utf8");
const secHeaders = {};
for (const line of headersFile.split("\n").slice(1)) {
  const m = line.match(/^\s+([\w-]+):\s*(.+)$/);
  if (!m) break; // alleen het eerste blok (/*)
  secHeaders[m[1]] = m[2];
}
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const file = path.join(root, u.pathname === "/" ? "index.html" : u.pathname);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "text/plain", ...secHeaders });
    res.end(fs.readFileSync(file));
  })
  .listen(8799, "127.0.0.1", () => console.log("up"));
