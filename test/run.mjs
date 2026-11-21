import assert from "node:assert/strict";
import * as L from "../public/js/logic.js";
import { challengeFor } from "../public/js/spotify.js";
import { onRequestGet, onRequest } from "../functions/api/[[route]].js";

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log("ok  ", name);
  } catch (e) {
    console.error("FAIL", name, "\n", e);
    process.exitCode = 1;
  }
};
const uri = (c) => "spotify:track:" + c.repeat(22);

// ---------------- logica ----------------
await test("tempoMatches: marge, afronding, ontbrekend tempo", () => {
  assert.equal(L.tempoMatches(120.4, 120, 0), true);
  assert.equal(L.tempoMatches(121.6, 120, 1), false);
  assert.equal(L.tempoMatches(121.4, 120, 1), true);
  assert.equal(L.tempoMatches(null, 120, 5), false);
  assert.equal(L.tempoMatches(undefined, 120, 5), false);
  assert.equal(L.tempoMatches("abc", 120, 5), false);
});

await test("normKey negeert accenten, (remaster), feat. en hoofdletters", () => {
  assert.equal(L.normKey("Café del Mar (Remastered 2019)", "Energy 52"), L.normKey("cafe del mar", "ENERGY 52"));
  assert.equal(L.normKey("Song feat. X", "A & B"), L.normKey("Song", "A and B"));
});

await test("buildPool: ontdubbelt, behoudt volgorde en negeert rommel", () => {
  const t = [{ name: "A", artist: "X" }, { name: "a (live)", artist: "x" }, null, { name: "", artist: "Q" }, { name: "B", artist: "Y" }];
  assert.deepEqual(L.buildPool({ genreTracks: t }).map((c) => c.title), ["A", "B"]);
  assert.deepEqual(L.buildPool({}), []);
});

await test("releaseYear en yearMatches", () => {
  assert.equal(L.releaseYear("1999"), 1999);
  assert.equal(L.releaseYear("1999-05"), 1999);
  assert.equal(L.releaseYear("1999-05-21"), 1999);
  assert.equal(L.releaseYear("onbekend"), null);
  assert.equal(L.releaseYear(undefined), null);
  assert.equal(L.yearMatches(1985, 1980, 1989), true);
  assert.equal(L.yearMatches(1980, 1980, 1989), true);
  assert.equal(L.yearMatches(1989, 1980, 1989), true);
  assert.equal(L.yearMatches(1990, 1980, 1989), false);
  assert.equal(L.yearMatches(1985, 1989, 1980), true);
  assert.equal(L.yearMatches(null, 1950, 2026), false);
});

await test("pickBestMatch kiest het juiste nummer en weigert verkeerde artiest", () => {
  const tracks = [
    { uri: uri("a"), name: "Blinding Lights", artists: ["Some Cover Band"] },
    { uri: uri("b"), name: "Blinding Lights - Remastered", artists: ["The Weeknd"] },
  ];
  assert.equal(L.pickBestMatch(tracks, { title: "Blinding Lights", artist: "The Weeknd" }).uri, uri("b"));
  assert.equal(L.pickBestMatch(tracks, { title: "Other Song", artist: "The Weeknd" }), null);
  assert.equal(L.pickBestMatch([{ uri: "spotify:track:short", name: "X", artists: ["Y"] }], { title: "X", artist: "Y" }), null);
});

await test("buildSearchQuery en mapSpotifyTracks", () => {
  assert.equal(L.buildSearchQuery({ title: 'Song (Live) "x"', artist: "A: B" }), "track:Song x artist:A B");
  assert.equal(L.buildSearchQuery({ title: "", artist: "A" }), "");
  assert.equal(L.buildSearchQuery({ q: "  hello   world " }), "hello world");
  assert.equal(L.buildSearchQuery({ q: "x".repeat(300) }).length, 100);
  const mapped = L.mapSpotifyTracks({ tracks: { items: [
    { uri: uri("a"), name: "N", artists: [{ name: "R" }], album: { name: "Al", release_date: "1987-03-02", images: [{ url: "u1" }, { url: "u2" }] }, duration_ms: 5 },
    { uri: "spotify:track:bad", name: "X" }, null,
  ] } });
  assert.deepEqual(mapped, [{ uri: uri("a"), name: "N", artists: ["R"], album: "Al", image: "u2", durationMs: 5, year: 1987 }]);
  assert.deepEqual(L.mapSpotifyTracks(null), []);
});

await test("spotifyIdFromUri", () => {
  assert.equal(L.spotifyIdFromUri(uri("a")), "a".repeat(22));
  assert.equal(L.spotifyIdFromUri("spotify:track:../x"), "");
});

await test("moveItem en sortTracks (BPM met null achteraan, titel, shuffle behoudt items)", () => {
  assert.deepEqual(L.moveItem([1, 2, 3, 4], 0, 2), [2, 3, 1, 4]);
  assert.deepEqual(L.moveItem([1, 2], 5, 0), [1, 2]);
  const t = [
    { title: "b", artist: "z", bpm: 130 },
    { title: "a", artist: "y", bpm: null },
    { title: "c", artist: "x", bpm: 100 },
  ];
  assert.deepEqual(L.sortTracks(t, "bpm-asc").map((x) => x.title), ["c", "b", "a"]);
  assert.deepEqual(L.sortTracks(t, "bpm-desc").map((x) => x.title), ["b", "c", "a"]);
  assert.deepEqual(L.sortTracks(t, "title").map((x) => x.title), ["a", "b", "c"]);
  assert.deepEqual(L.sortTracks(t, "artist").map((x) => x.artist), ["x", "y", "z"]);
  assert.equal(L.sortTracks(t, "shuffle").length, 3);
  assert.deepEqual(t.map((x) => x.title), ["b", "a", "c"], "origineel niet gemuteerd");
});

await test("toCsv: quotes, formule-injectie en Spotify-links", () => {
  const csv = L.toCsv([{ title: '=HYPERLINK("x")', artist: 'A "B"', bpm: 120, uri: uri("a") }]);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /"A ""B"""/);
  assert.match(csv, /https:\/\/open\.spotify\.com\/track\/a{22}/);
});

await test("formatDuration", () => {
  assert.equal(L.formatDuration(215000), "3:35");
  assert.equal(L.formatDuration(3723000), "1u 02m");
});

// ---------------- PKCE ----------------
await test("PKCE challenge klopt met RFC 7636 testvector", async () => {
  assert.equal(
    await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

// ---------------- proxy ----------------
const calls = [];
const store = new Map();
globalThis.caches = {
  default: {
    async match(req) {
      const hit = store.get(req.url);
      return hit ? hit.clone() : undefined;
    },
    async put(req, res) {
      store.set(req.url, res);
    },
  },
};
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, init });
  const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
  if (u.startsWith("https://api.reccobeats.com/v1/audio-features")) {
    const ids = new URL(u).searchParams.get("ids").split(",");
    // ID's die met 'z' beginnen kent ReccoBeats niet.
    return ok({ content: ids.filter((i) => !i.startsWith("z")).map((i) => ({ id: "uuid-" + i, href: "https://open.spotify.com/track/" + i, tempo: 120.5 })) });
  }
  if (u.startsWith("https://ws.audioscrobbler.com/")) {
    const method = new URL(u).searchParams.get("method");
    return ok({ tracks: { track: [{ name: method, artist: { name: "R" } }, { bad: true }] } });
  }
  return new Response("{}", { status: 500 });
};

const env = { LASTFM_KEY: "KEY_LFM" };
const run = async (path, { headers = {}, e = env } = {}) => {
  const pending = [];
  const res = await onRequestGet({ request: new Request("https://site.test" + path, { headers }), env: e, waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  return { res, body: await res.clone().json() };
};
const ID1 = "A".repeat(22), ID2 = "B".repeat(22), ID3 = "C".repeat(22), UNK = "z".repeat(22);

await test("proxy: tempo geeft per Spotify-ID een tempo, null voor onbekend, zonder API-key", async () => {
  const before = calls.length;
  const { res, body } = await run(`/api/tempo?ids=${ID1},${ID2},${UNK}`);
  assert.equal(res.status, 200);
  assert.deepEqual(body.tempos, { [ID1]: 120.5, [ID2]: 120.5, [UNK]: null });
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.ok(!calls[before].init.headers || !("X-API-KEY" in calls[before].init.headers));
});

await test("proxy: tempo cachet per ID en vraagt alleen ontbrekende ID's op", async () => {
  const n = calls.length;
  const again = await run(`/api/tempo?ids=${ID1},${ID2},${ID3}`);
  assert.equal(again.body.tempos[ID3], 120.5);
  assert.equal(calls.length, n + 1, "één aanvraag, enkel voor het nieuwe ID");
  assert.equal(new URL(calls[n].url).searchParams.get("ids"), ID3);
  const n2 = calls.length;
  await run(`/api/tempo?ids=${ID1},${ID2},${ID3},${UNK}`);
  assert.equal(calls.length, n2, "alles uit de cache, ook het onbekende ID");
});

await test("proxy: invoer wordt gevalideerd", async () => {
  const many = Array.from({ length: 21 }, (_, i) => String.fromCharCode(65 + i).repeat(22)).join(",");
  const bad = [
    "/api/tempo", "/api/tempo?ids=abc", `/api/tempo?ids=${ID1},../../x`, `/api/tempo?ids=${many}`,
    "/api/lastfm?country=Belgium&page=9", "/api/lastfm?country=%3Cscript%3E&page=1",
    "/api/lastfm-tag?tag=%3Cb%3E&page=1", "/api/lastfm-tag?tag=pop&page=0", "/api/chart?page=4",
  ];
  for (const p of bad) assert.equal((await run(p)).res.status, 400, p);
  assert.equal((await run("/api/nope")).res.status, 404);
  assert.equal((await run("/api/search?q=abc")).res.status, 404, "Spotify gaat niet meer via de proxy");
  assert.equal((await run("/api/constructor")).res.status, 404, "geen prototype-lookup");
});

await test("proxy: Last.fm-routes (land, genre, wereldtop) filteren rommel en gebruiken de juiste methode", async () => {
  assert.deepEqual((await run("/api/lastfm?country=Belgium&page=1")).body.tracks, [{ name: "geo.gettoptracks", artist: "R" }]);
  assert.deepEqual((await run("/api/lastfm-tag?tag=hip-hop&page=2")).body.tracks, [{ name: "tag.gettoptracks", artist: "R" }]);
  assert.deepEqual((await run("/api/chart?page=1")).body.tracks, [{ name: "chart.gettoptracks", artist: "R" }]);
  const tagCall = calls.findLast((c) => c.url.includes("tag.gettoptracks"));
  assert.equal(new URL(tagCall.url).searchParams.get("tag"), "hip-hop");
});

await test("proxy: vreemde websites in de browser worden geweigerd", async () => {
  assert.equal((await run(`/api/tempo?ids=${ID1}`, { headers: { "Sec-Fetch-Site": "cross-site" } })).res.status, 403);
  assert.equal((await run(`/api/tempo?ids=${ID1}`, { headers: { "Sec-Fetch-Site": "same-origin" } })).res.status, 200);
});

await test("proxy: ontbrekende key geeft duidelijke fout zonder waarden te lekken", async () => {
  const { res, body } = await run("/api/chart?page=2", { e: { ...env, LASTFM_KEY: "" } });
  assert.equal(res.status, 500);
  assert.match(body.error, /LASTFM_KEY/);
});

await test("proxy: upstream-fout (429) wordt 502 en niet gecachet", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 429 });
  const tempo = await run(`/api/tempo?ids=${"D".repeat(22)}`);
  const chart = await run("/api/chart?page=3");
  globalThis.fetch = realFetch;
  assert.equal(tempo.res.status, 502);
  assert.match(tempo.body.error, /limiet/);
  assert.equal(chart.res.status, 502);
  assert.equal(store.has("https://site.test/api/chart?page=3"), false);
  assert.equal(store.has(`https://cache.internal/tempo/${"D".repeat(22)}`), false);
});

await test("proxy: andere methoden geweigerd", () => {
  assert.equal(onRequest().status, 405);
});

console.log(`\n${passed} tests geslaagd`);
