// Testserver: serveert public/ met de CSP uit _headers en nagebootste /api-antwoorden.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve("public");
const headersFile = fs.readFileSync(path.join(root, "_headers"), "utf8");
const secHeaders = {};
for (const line of headersFile.split("\n").slice(1)) {
  const m = line.match(/^\s+([\w-]+):\s*(.+)$/);
  if (m) secHeaders[m[1]] = m[2];
}
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
const uri = (c) => "spotify:track:" + c.repeat(22);
const tempo = [
  { song_id: "1", song_title: "Belgian Banger", tempo: "120", artist: { id: "a1", name: "Stromae", genres: ["pop", "dance"], from: "Brussels, Belgium" } },
  { song_id: "2", song_title: "Intl Pop", tempo: "119", artist: { id: "a2", name: "Star", genres: ["pop"], from: "USA" } },
  { song_id: "3", song_title: "Metal Thing", tempo: "121", artist: { id: "a3", name: "Heavy", genres: ["metal"], from: "Sweden" } },
  { song_id: "4", song_title: "<img src=x onerror=alert(1)>", tempo: "120", artist: { id: "a4", name: "Evil", genres: ["pop"], from: "Belgium" } },
];
const json = (res, data, status = 200) => {
  res.writeHead(status, { "content-type": "application/json", ...secHeaders });
  res.end(JSON.stringify(data));
};
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/tempo") return json(res, { tempo });
  if (u.pathname === "/api/lastfm") return json(res, { tracks: [{ name: "Intl Pop", artist: "Star" }] });
  if (u.pathname === "/api/search") {
    const q = u.searchParams.get("title") || u.searchParams.get("q") || "x";
    const artist = u.searchParams.get("artist") || "Manual Artist";
    return json(res, { tracks: [{ uri: uri(q.length % 2 ? "a" : "b"), name: u.searchParams.get("title") || q, artists: [artist], album: "Album", image: "", durationMs: 200000 }] });
  }
  const file = path.join(root, u.pathname === "/" ? "index.html" : u.pathname);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(file)] || "text/plain", ...secHeaders });
  res.end(fs.readFileSync(file));
}).listen(8799, "127.0.0.1", () => console.log("up"));
