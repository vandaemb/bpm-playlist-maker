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

// Tempo per nummer (titel). Het Spotify-ID wordt afgeleid van de titel.
const TEMPO = { "Belgian Banger": 120, "Intl Pop": 119, "Slow Song": 80, "<img src=x onerror=alert1>": 121, "Pop Hit": 120 };
const idFor = (title) => (Buffer.from(title).toString("hex") + "x".repeat(22)).slice(0, 22);
const idToTempo = {};
for (const [t, bpm] of Object.entries(TEMPO)) idToTempo[idFor(t)] = bpm;

// Deezer-gegevens per titel: [bpm, jaar, isrc]
const DZ = {
  "Belgian Banger": [120, 1985, "TESTBB000001"],
  "Intl Pop": [119, 1995, "TESTIP000001"],
  "Slow Song": [80, 2001, "TESTSS000001"],
  "<img src=x onerror=alert1>": [121, 2010, "TESTIM000001"],
  "Pop Hit": [120, 1975, "TESTPH000001"],
};
const TAG_POP = [
  { name: "Intl Pop", artist: { name: "Star" } },
  { name: "Pop Hit", artist: { name: "Someone" } },
  { name: "Belgian Banger", artist: { name: "Stromae" } },
  { name: "<img src=x onerror=alert1>", artist: { name: "Evil" } },
  { name: "Slow Song", artist: { name: "Calm" } },
];

const json = (res, data, status = 200) => {
  res.writeHead(status, { "content-type": "application/json", ...secHeaders });
  res.end(JSON.stringify(data));
};
http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const page = u.searchParams.get("page");
    if (u.pathname === "/api/lastfm-tag") return json(res, { tracks: page === "1" ? TAG_POP.map((t) => ({ name: t.name, artist: t.artist.name })) : [] });
    if (u.pathname === "/api/deezer") {
      const titles = u.searchParams.getAll("t");
      return json(res, { items: titles.map((t) => (DZ[t] ? { ok: true, found: true, tempo: DZ[t][0], year: DZ[t][1], isrc: DZ[t][2] } : { ok: true, found: false, tempo: null, year: null, isrc: "" })) });
    }
    if (u.pathname === "/api/tempo") {
      const ids = (u.searchParams.get("ids") || "").split(",");
      return json(res, { tempos: Object.fromEntries(ids.map((i) => [i, idToTempo[i] ?? null])) });
    }
    const file = path.join(root, u.pathname === "/" ? "index.html" : u.pathname);
    if (!file.startsWith(root) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "text/plain", ...secHeaders });
    res.end(fs.readFileSync(file));
  })
  .listen(8799, "127.0.0.1", () => console.log("up"));
