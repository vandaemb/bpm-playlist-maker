import assert from "node:assert/strict";
import * as L from "../public/js/logic.js";
import { challengeFor } from "../public/js/spotify.js";

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
await test("dataBuckets: blokken van 10 BPM die bpm ± marge afdekken", () => {
  assert.deepEqual(L.dataBuckets(120, 0), [120]);
  assert.deepEqual(L.dataBuckets(119, 2), [110, 120]);
  assert.deepEqual(L.dataBuckets(125, 5), [120, 130]);
  assert.deepEqual(L.dataBuckets(45, 5), [40, 50]);
  assert.deepEqual(L.dataBuckets(41, 1), [40]);
  assert.deepEqual(L.dataBuckets(220, 5), [210]);
});

await test("genreIndexSet: alle woorden moeten in de tag voorkomen, leeg = geen filter", () => {
  const names = ["rock", "dance pop", "pop dance", "indie pop", "hip hop"];
  assert.equal(L.genreIndexSet(names, "  "), null);
  assert.deepEqual([...L.genreIndexSet(names, "pop")], [1, 2, 3]);
  assert.deepEqual([...L.genreIndexSet(names, "Dance Pop")], [1, 2]);
  assert.deepEqual([...L.genreIndexSet(names, "HIP-HOP")], [4]);
  assert.equal(L.genreIndexSet(names, "metal").size, 0);
});

await test("filterRows: tempo, jaar, genre, ontdubbeling en volgorde (populairste eerst)", () => {
  const ID = (c) => c.repeat(22);
  const rows = [
    [ID("a"), "Song A", "Art 1", 120.2, 1985, 50, [1]],
    [ID("b"), "Song B", "Art 2", 121.9, 1995, 80, [1, 2]],
    [ID("c"), "Song C", "Art 3", 130, 1995, 99, [1]],   // tempo valt buiten de marge
    [ID("d"), "Song D", "Art 4", 120, 2010, 70, [0]],   // ander genre
    [ID("e"), "Song A (Remastered)", "Art 1", 120, 1985, 10, [1]], // dubbel van A
    [ID("f"), "Song F", "Art 6", 119.8, 1970, 60, [1]],  // te oud
    ["bad id", "Song G", "Art 7", 120, 1990, 90, [1]],   // ongeldige Spotify-ID
  ];
  const out = L.filterRows(rows, { bpm: 120, tol: 2, from: 1980, to: 2000, genreSet: new Set([1, 2]) });
  assert.deepEqual(out.map((o) => o.title), ["Song B", "Song A"]);
  assert.equal(out[0].uri, `spotify:track:${ID("b")}`);
  assert.equal(out[0].bpm, 122);
  assert.equal(L.filterRows(rows, { bpm: 120, tol: 2, from: 1950, to: 2026, genreSet: null }).length, 4);
});

await test("PKCE challenge klopt met RFC 7636 testvector", async () => {
  assert.equal(
    await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

// ---------------- proxy ----------------

console.log(`\n${passed} tests geslaagd`);
