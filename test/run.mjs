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

// ---------------- logica ----------------
await test("bpmRange: tolerantie, grenzen en clamping", () => {
  assert.deepEqual(L.bpmRange(120, 2), [118, 119, 120, 121, 122]);
  assert.deepEqual(L.bpmRange(41, 3), [40, 41, 42, 43, 44]);
  assert.deepEqual(L.bpmRange(219, 5), [214, 215, 216, 217, 218, 219, 220]);
  assert.deepEqual(L.bpmRange(120, 99).length, 11);
  assert.deepEqual(L.bpmRange("abc", 1), []);
});

await test("normKey negeert accenten, (remaster), feat. en hoofdletters", () => {
  assert.equal(L.normKey("Café del Mar (Remastered 2019)", "Energy 52"), L.normKey("cafe del mar", "ENERGY 52"));
  assert.equal(L.normKey("Song feat. X", "A & B"), L.normKey("Song", "A and B"));
});

await test("normalizeTempoItem: object- en array-artiest, ongeldige items", () => {
  const raw = { song_id: "abc", song_title: "Blinding Lights", tempo: "171", artist: { id: "x1", name: "The Weeknd", genres: ["pop", "r&b"], from: "Canada" } };
  const n = L.normalizeTempoItem(raw);
  assert.equal(n.bpm, 171);
  assert.equal(n.artistId, "x1");
  assert.equal(n.hasArtistInfo, true);
  assert.equal(L.normalizeTempoItem({ ...raw, artist: [raw.artist] }).artist, "The Weeknd");
  const bare = L.normalizeTempoItem({ ...raw, artist: { id: "x1", name: "The Weeknd" } });
  assert.equal(bare.hasArtistInfo, false);
  assert.equal(L.normalizeTempoItem({ song_id: "1", song_title: "", tempo: "1", artist: { name: "a" } }), null);
  assert.equal(L.normalizeTempoItem(null), null);
});

await test("parseList accepteert array, wrapper en rommel", () => {
  assert.deepEqual(L.parseList({ tempo: [1] }, "tempo"), [1]);
  assert.deepEqual(L.parseList([2], "tempo"), [2]);
  assert.deepEqual(L.parseList({ tempo: { error: "no result" } }, "tempo"), []);
  assert.deepEqual(L.parseList(null, "tempo"), []);
});

await test("genreMatches: deelstring, koppelteken, leeg = alles", () => {
  assert.equal(L.genreMatches(["hip-hop", "rap"], "hip hop"), true);
  assert.equal(L.genreMatches(["Dance Pop"], "pop"), true);
  assert.equal(L.genreMatches(["rock"], "jazz"), false);
  assert.equal(L.genreMatches([], "pop"), false);
  assert.equal(L.genreMatches([], ""), true);
});

await test("ranking: land-score, strict, BPM-afstand en ontdubbeling", () => {
  const be = L.makeCountry("BE", "Belgium");
  const local = L.buildLocalSet([{ name: "Hit Local", artist: "Pop Ster" }]);
  const mk = (id, title, artist, bpm, from = "", genres = ["pop"]) => ({ id, title, artist, bpm, from, genres });
  const cands = [
    mk("1", "Far", "Intl", 118),
    mk("2", "Near", "Intl", 120),
    mk("3", "Belgian", "Stromae", 119, "Brussels, Belgium"),
    mk("4", "Hit Local", "Pop Ster", 121),
    mk("5", "Belgian", "Stromae", 119, "Belgium"), // duplicaat
    mk("6", "Rocker", "Band", 120, "Belgium", ["rock"]),
  ];
  const all = L.rankCandidates(cands, { bpm: 120, genre: "pop", country: be, local, strict: false });
  assert.deepEqual(all.map((c) => c.title), ["Belgian", "Hit Local", "Near", "Far"]);
  const strict = L.rankCandidates(cands, { bpm: 120, genre: "pop", country: be, local, strict: true });
  assert.deepEqual(strict.map((c) => c.title), ["Belgian", "Hit Local"]);
  assert.equal(all[0].locScore, 3);
  assert.equal(all[1].locScore, 2);
});

await test("makeCountry kent aliassen (UK) en Last.fm-naam", () => {
  const gb = L.makeCountry("GB", "United Kingdom");
  assert.ok(gb.names.includes("england"));
  assert.equal(L.makeCountry("CZ", "Czechia").en, "Czech Republic");
});

await test("pickBestMatch kiest het juiste nummer en weigert verkeerde artiest", () => {
  const uri = (c) => "spotify:track:" + c.repeat(22);
  const tracks = [
    { uri: uri("a"), name: "Blinding Lights", artists: ["Some Cover Band"] },
    { uri: uri("b"), name: "Blinding Lights - Remastered", artists: ["The Weeknd"] },
  ];
  assert.equal(L.pickBestMatch(tracks, { title: "Blinding Lights", artist: "The Weeknd" }).uri, uri("b"));
  assert.equal(L.pickBestMatch(tracks, { title: "Other Song", artist: "The Weeknd" }), null);
  assert.equal(L.pickBestMatch([{ uri: "spotify:track:short", name: "X", artists: ["Y"] }], { title: "X", artist: "Y" }), null);
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
  const csv = L.toCsv([{ title: '=HYPERLINK("x")', artist: 'A "B"', bpm: 120, uri: "spotify:track:" + "a".repeat(22) }]);
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
  if (u.startsWith("https://accounts.spotify.com/api/token")) return ok({ access_token: "APPTOKEN", expires_in: 3600 });
  if (u.startsWith("https://api.getsongbpm.com/tempo/")) return ok({ tempo: [{ song_id: "1", song_title: "T", tempo: "120", artist: { id: "a", name: "A" } }] });
  if (u.startsWith("https://api.getsongbpm.com/artist/")) return ok({ artist: { id: "a", name: "A", genres: ["pop"], from: "Belgium" } });
  if (u.startsWith("https://ws.audioscrobbler.com/")) return ok({ tracks: { track: [{ name: "N", artist: { name: "R" } }, { bad: true }] } });
  if (u.startsWith("https://api.spotify.com/v1/search")) {
    return ok({ tracks: { items: [{ uri: "spotify:track:" + "a".repeat(22), name: "N", artists: [{ name: "R" }], album: { name: "Al", images: [{ url: "https://i.scdn.co/1" }, { url: "https://i.scdn.co/2" }] }, duration_ms: 1000 }] } });
  }
  return new Response("{}", { status: 500 });
};

const env = { GETSONGBPM_KEY: "KEY_GSB", LASTFM_KEY: "KEY_LFM", SPOTIFY_CLIENT_ID: "cid", SPOTIFY_CLIENT_SECRET: "SECRET" };
const run = async (path, { headers = {}, e = env } = {}) => {
  const pending = [];
  const res = await onRequestGet({ request: new Request("https://site.test" + path, { headers }), env: e, waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  return { res, body: await res.clone().json() };
};

await test("proxy: tempo gebruikt key als header (niet in URL) en cachet", async () => {
  const before = calls.length;
  const a = await run("/api/tempo?bpm=120");
  assert.equal(a.res.status, 200);
  assert.equal(a.body.tempo[0].song_id, "1");
  const call = calls[before];
  assert.equal(call.init.headers["X-API-KEY"], "KEY_GSB");
  assert.ok(!call.url.includes("KEY_GSB"));
  const n = calls.length;
  await run("/api/tempo?bpm=120");
  assert.equal(calls.length, n, "tweede aanvraag komt uit de cache");
});

await test("proxy: invoer wordt gevalideerd", async () => {
  for (const p of ["/api/tempo?bpm=10", "/api/tempo?bpm=abc", "/api/tempo", "/api/artist?id=../../x", "/api/lastfm?country=Belgium&page=9", "/api/lastfm?country=%3Cscript%3E&page=1", "/api/search?q=" + "x".repeat(101), "/api/search?title=x"]) {
    const { res } = await run(p);
    assert.equal(res.status, 400, p);
  }
  assert.equal((await run("/api/nope")).res.status, 404);
  assert.equal((await run("/api/constructor")).res.status, 404, "geen prototype-lookup");
});

await test("proxy: Spotify-search levert slank resultaat, secret lekt niet", async () => {
  const { res, body } = await run("/api/search?title=N%20(Remastered)&artist=R");
  assert.equal(res.status, 200);
  assert.deepEqual(body.tracks[0], { uri: "spotify:track:" + "a".repeat(22), name: "N", artists: ["R"], album: "Al", image: "https://i.scdn.co/2", durationMs: 1000 });
  const searchCall = calls.findLast((c) => c.url.startsWith("https://api.spotify.com/v1/search"));
  assert.ok(searchCall.url.includes("track%3AN+artist%3AR"), searchCall.url);
  assert.ok(!JSON.stringify(body).includes("SECRET"));
  assert.equal(searchCall.init.headers.Authorization, "Bearer APPTOKEN");
});

await test("proxy: lastfm filtert rommel", async () => {
  const { body } = await run("/api/lastfm?country=Belgium&page=1");
  assert.deepEqual(body.tracks, [{ name: "N", artist: "R" }]);
});

await test("proxy: vreemde websites in de browser worden geweigerd", async () => {
  assert.equal((await run("/api/artist?id=abc", { headers: { "Sec-Fetch-Site": "cross-site" } })).res.status, 403);
  assert.equal((await run("/api/artist?id=abc", { headers: { "Sec-Fetch-Site": "same-origin" } })).res.status, 200);
});

await test("proxy: ontbrekende key geeft duidelijke fout zonder waarden te lekken", async () => {
  const { res, body } = await run("/api/tempo?bpm=121", { e: { ...env, GETSONGBPM_KEY: "" } });
  assert.equal(res.status, 500);
  assert.match(body.error, /GETSONGBPM_KEY/);
});

await test("proxy: upstream-fout wordt 502 en niet gecachet", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 429 });
  const { res, body } = await run("/api/tempo?bpm=122");
  globalThis.fetch = realFetch;
  assert.equal(res.status, 502);
  assert.match(body.error, /limiet/);
  assert.equal(store.has("https://site.test/api/tempo?bpm=122"), false);
});

await test("proxy: andere methoden geweigerd", () => {
  assert.equal(onRequest().status, 405);
});

console.log(`\n${passed} tests geslaagd`);
