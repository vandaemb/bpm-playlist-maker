import { CONFIG } from "./config.js";
import * as L from "./logic.js";
import * as S from "./spotify.js";

const $ = (id) => document.getElementById(id);
const DRAFT_KEY = "bpm-playlist-draft-v1";
const BATCH = 20; // kandidaten per ronde (ook max. aantal ID's per tempo-aanvraag)
const FIRST_GOAL = 30;
const MORE_GOAL = 25;

// ---------- kleine DOM-helper: gebruikt uitsluitend textContent, nooit innerHTML ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function safeImage(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "i.scdn.co" || u.hostname.endsWith(".scdn.co")) ? u.href : "";
  } catch {
    return "";
  }
}

function cover(url) {
  const src = safeImage(url);
  return src ? h("img", { class: "cover", src, alt: "", loading: "lazy", width: 44, height: 44 }) : h("div", { class: "cover" });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- netwerk ----------
async function api(path, params = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x));
    else url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    let msg = "";
    try {
      msg = (await res.json()).error;
    } catch {}
    throw new Error(msg || `Serverfout ${res.status}`);
  }
  return res.json();
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        out[i] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

// ---------- bewaarde Spotify-zoekresultaten ----------
// Onthoudt per nummer wat Spotify teruggaf (ook "geen match"), zodat herhaalde of hervatte zoekopdrachten
// geen Spotify-aanvragen verspillen.
const MATCH_KEY = "bpm-spotify-matches-v1";
const MATCH_MAX = 3000;
const matchCache = (() => {
  try {
    const d = JSON.parse(localStorage.getItem(MATCH_KEY) || "{}");
    return d && typeof d === "object" && !Array.isArray(d) ? d : {};
  } catch {
    return {};
  }
})();

function rememberMatch(key, best) {
  const keys = Object.keys(matchCache);
  if (keys.length >= MATCH_MAX) for (const k of keys.slice(0, 500)) delete matchCache[k];
  matchCache[key] = best
    ? { uri: best.uri, name: best.name, artists: best.artists.slice(0, 3), album: best.album, image: best.image, durationMs: best.durationMs, year: best.year }
    : 0;
  try {
    localStorage.setItem(MATCH_KEY, JSON.stringify(matchCache));
  } catch {}
}

function recalledMatch(key) {
  if (!Object.hasOwn(matchCache, key)) return undefined;
  const m = matchCache[key];
  if (!m) return null;
  return L.SPOTIFY_TRACK_URI.test(String(m.uri)) && Array.isArray(m.artists) ? m : undefined;
}

// ---------- staat ----------
const state = { results: [], scan: null, scanId: 0, playlist: loadDraft(), dragFrom: -1 };

function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    if (!d || !Array.isArray(d.items)) throw 0;
    const items = d.items
      .filter((i) => i && L.SPOTIFY_TRACK_URI.test(String(i.uri)))
      .map((i) => ({
        key: String(i.key),
        title: String(i.title),
        artist: String(i.artist),
        bpm: Number.isFinite(i.bpm) ? i.bpm : null,
        uri: i.uri,
        image: safeImage(i.image),
        durationMs: Number(i.durationMs) || 0,
      }));
    return { name: String(d.name || "Mijn BPM-playlist").slice(0, 100), items };
  } catch {
    return { name: "Mijn BPM-playlist", items: [] };
  }
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(state.playlist));
  } catch {}
}

function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = kind;
}

// ---------- jaarbereik ----------
const MAX_YEAR = new Date().getFullYear();

function setupYears() {
  for (const id of ["year-from", "year-to"]) {
    const el = $(id);
    el.min = String(L.MIN_YEAR);
    el.max = String(MAX_YEAR);
  }
  $("year-from").value = String(L.MIN_YEAR);
  $("year-to").value = String(MAX_YEAR);
  $("year-from").addEventListener("input", () => syncYears("from"));
  $("year-to").addEventListener("input", () => syncYears("to"));
  syncYears();
}

// Houdt "van" altijd <= "tot": de schuif die je beweegt duwt de andere mee.
function syncYears(moved) {
  let from = Number($("year-from").value);
  let to = Number($("year-to").value);
  if (from > to) {
    if (moved === "from") to = from;
    else from = to;
    $("year-from").value = String(from);
    $("year-to").value = String(to);
  }
  $("year-label").textContent = from === to ? `${from}` : `${from} – ${to}`;
}

const currentYears = () => [Number($("year-from").value), Number($("year-to").value)];

// ---------- zoeken ----------
// Stappen: (1) kandidaten uit Last.fm (land en/of genre), (2) per kandidaat het echte nummer op
// Deezer vragen om BPM, jaar en ISRC (geen Spotify nodig), (3) alleen voor nummers die kloppen het echte nummer op Spotify zoeken.
// Dat gebeurt in rondes van 20, zodat de eerste resultaten snel verschijnen.
async function fetchLastfm(path, params, pages) {
  const settled = await Promise.allSettled(Array.from({ length: pages }, (_, i) => api(path, { ...params, page: i + 1 })));
  return settled.filter((r) => r.status === "fulfilled").flatMap((r) => r.value.tracks || []);
}

// Deezer opvragen met geduld bij tijdelijke fouten.
const DEEZER_WAITS = [3, 8, 20];
async function fetchDeezer(batch, onWait) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await api("/api/deezer", { a: batch.map((c) => c.artist), t: batch.map((c) => c.title) });
      return Array.isArray(res.items) ? res.items : [];
    } catch (err) {
      if (attempt >= DEEZER_WAITS.length) throw err;
      for (let left = DEEZER_WAITS[attempt]; left > 0; left--) {
        onWait?.(left);
        await sleep(1000);
      }
    }
  }
}

// Zoekt het nummer op Spotify: eerst op ISRC (exact), anders op titel en artiest. Resultaten worden bewaard.
async function findOnSpotify(token, c, d) {
  const key = L.normKey(c.title, c.artist);
  const recalled = recalledMatch(key);
  if (recalled !== undefined) return recalled;
  let best = null;
  if (d.isrc) {
    const byIsrc = await S.searchTracks(token, `isrc:${d.isrc}`);
    best = byIsrc[0] || null;
  }
  if (!best) {
    let tracks = await S.searchTracks(token, L.buildSearchQuery({ title: c.title, artist: c.artist }));
    if (!tracks.length) tracks = await S.searchTracks(token, L.buildSearchQuery({ q: `${c.artist} ${c.title}` }));
    best = L.pickBestMatch(tracks, c);
  }
  rememberMatch(key, best);
  return best;
}

async function onSearch(ev) {
  ev.preventDefault();
  const bpm = Number($("bpm").value);
  if (!Number.isFinite(bpm) || bpm < L.MIN_BPM || bpm > L.MAX_BPM) {
    return setStatus(`Kies een BPM tussen ${L.MIN_BPM} en ${L.MAX_BPM}.`, "error");
  }
  if (!S.getToken()) {
    updateConnection();
    return setStatus("Verbind eerst met Spotify (knop hierboven). Zonder verbinding kan de site de nummers niet op Spotify zoeken.", "error");
  }
  const tol = Number($("tol").value);
  const genre = $("genre").value.trim().slice(0, 40);
  if (!genre) return setStatus("Kies een genre (bv. pop, rock, dance).", "error");
  const [yearFrom, yearTo] = currentYears();

  const id = ++state.scanId;
  state.scan = null;
  state.results = [];
  renderResults();
  $("search-btn").disabled = true;
  try {
    setStatus(`Populaire nummers in het genre "${genre}" ophalen…`);
    const genreTracks = await fetchLastfm("/api/lastfm-tag", { tag: genre }, 10);
    if (!genreTracks.length) throw new Error("Last.fm gaf geen nummers terug voor dit genre. Controleer de spelling of probeer een ander genre.");
    const candidates = L.buildPool({ genreTracks });
    state.scan = { id, candidates, index: 0, bpm, tol, yearFrom, yearTo, found: [], keys: new Set(), running: false, paused: "", failedBatches: 0, searchErrors: 0, outOfYears: 0, onSpotify: 0, withTempo: 0, noMatch: 0, sample: "", lastSearchError: "", dzErrors: 0, notOnDeezer: 0, noBpm: 0, hitsTotal: 0 };
    await continueScan(FIRST_GOAL);
  } catch (err) {
    setStatus(`Zoeken mislukt: ${err.message}`, "error");
  } finally {
    $("search-btn").disabled = false;
  }
}

// Laat zien waar nummers afvallen: handig om te zien welke stap weinig oplevert.
function breakdown(scan) {
  const onDeezer = scan.index - scan.notOnDeezer - scan.dzErrors;
  const parts = [`op Deezer gevonden: ${onDeezer}`, `met BPM: ${scan.withTempo}`, `binnen BPM en jaar: ${scan.hitsTotal}`, `op Spotify: ${scan.onSpotify}`];
  if (scan.noBpm) parts.push(`zonder BPM bij Deezer: ${scan.noBpm}`);
  if (scan.noMatch) parts.push(`niet op Spotify: ${scan.noMatch}`);
  if (scan.searchErrors) parts.push(`Spotify-fouten: ${scan.searchErrors} (laatste: ${scan.lastSearchError})`);
  return parts.join(", ");
}

async function continueScan(extra) {
  const scan = state.scan;
  if (!scan || scan.running) return;
  scan.running = true;
  scan.paused = "";
  scan.stopped = false;
  $("search-btn").disabled = true;
  $("more-btn").disabled = true;
  $("stop-btn").hidden = false;
  $("results-head").hidden = false;
  const goal = scan.found.length + extra;
  try {
    while (!scan.stopped && scan.found.length < goal && scan.index < scan.candidates.length && scan.id === state.scanId) {
      const batch = scan.candidates.slice(scan.index, scan.index + BATCH);
      scan.index += batch.length;
      setStatus(`Zoeken… ${scan.index} van ${scan.candidates.length} nummers gecontroleerd · ${scan.found.length} gevonden · ${breakdown(scan)}`);

      // Stap 1: Deezer geeft BPM, jaar en ISRC voor de hele groep. Dit kost geen Spotify-aanvragen.
      let info;
      try {
        info = await fetchDeezer(batch, (left) => {
          if (scan.id === state.scanId) setStatus(`Deezer reageert niet. Nieuwe poging over ${left} s… · ${scan.found.length} gevonden`);
        });
      } catch (err) {
        scan.index -= batch.length;
        scan.paused = `Deezer blijft fouten geven (${err.message})`;
        break;
      }
      if (scan.id !== state.scanId) return;
      const hits = [];
      batch.forEach((c, i) => {
        const d = info[i];
        if (!d?.ok) return void scan.dzErrors++;
        if (!d.found) return void scan.notOnDeezer++;
        if (d.tempo == null) return void scan.noBpm++;
        scan.withTempo++;
        if (!L.tempoMatches(d.tempo, scan.bpm, scan.tol)) return;
        if (d.year != null && !L.yearMatches(d.year, scan.yearFrom, scan.yearTo)) return void scan.outOfYears++;
        scan.hitsTotal++;
        hits.push({ c, d });
      });
      if (!hits.length) continue;

      // Stap 2: Spotify alleen voor de nummers die al kloppen (voor de link en de export).
      const token = S.getToken();
      if (!token) throw new S.SpotifyAuthError("Je Spotify-verbinding is verlopen. Verbind opnieuw met Spotify.");
      let limited = null;
      for (const { c, d } of hits) {
        let best;
        try {
          best = await findOnSpotify(token, c, d);
        } catch (err) {
          if (err instanceof S.SpotifyAuthError) throw err;
          if (err instanceof S.SpotifyRateLimitError) {
            limited = err;
            break;
          }
          scan.searchErrors++;
          scan.lastSearchError = err.message;
          continue;
        }
        if (scan.id !== state.scanId) return;
        if (!best) {
          scan.noMatch++;
          continue;
        }
        scan.onSpotify++;
        const year = d.year ?? best.year;
        if (!L.yearMatches(year, scan.yearFrom, scan.yearTo)) {
          scan.outOfYears++;
          continue;
        }
        const title = best.name;
        const artist = best.artists[0] || c.artist;
        const key = L.normKey(title, artist);
        if (scan.keys.has(key)) continue;
        scan.keys.add(key);
        scan.found.push({ key, title, artist, bpm: Math.round(d.tempo), uri: best.uri, image: safeImage(best.image), durationMs: best.durationMs, year });
      }
      if (limited) {
        // Wat al gevonden is blijft staan; Deezer-antwoorden en Spotify-zoekresultaten zijn bewaard, hervatten gaat snel.
        scan.index -= batch.length;
        scan.paused = limited.message;
        state.results = scan.found;
        renderResults();
        break;
      }
      state.results = scan.found;
      renderResults();
    }
  } catch (err) {
    if (scan.id === state.scanId) {
      setStatus(`Zoeken mislukt: ${err.message}`, "error");
      updateConnection();
    }
    return;
  } finally {
    scan.running = false;
    $("stop-btn").hidden = true;
    if (scan.id === state.scanId) {
      $("search-btn").disabled = false;
      $("more-btn").disabled = false;
      renderResults();
    }
  }
  if (scan.id !== state.scanId) return;

  const exhausted = scan.index >= scan.candidates.length;
  if (scan.paused) {
    return setStatus(`Gepauzeerd: ${scan.paused} ${scan.found.length} nummers gevonden tot nu toe. Wacht een paar minuten en klik op "Meer zoeken" om verder te gaan (reeds gecontroleerde nummers worden onthouden). · ${breakdown(scan)}`, "error");
  }
  if (scan.stopped) return setStatus(`Gestopt · ${scan.found.length} nummers gevonden · ${scan.index} van ${scan.candidates.length} gecontroleerd. Klik op "Meer zoeken" om verder te gaan. · ${breakdown(scan)}`);
  const parts = [`${scan.found.length} nummers gevonden`];
  parts.push(exhausted ? "alle kandidaten zijn gecontroleerd" : `${scan.index} van ${scan.candidates.length} gecontroleerd, klik op "Meer zoeken" voor meer`);
  if (!scan.found.length && exhausted) parts.push("probeer een grotere marge, een breder jaarbereik of een ander genre");
  if (scan.failedBatches) parts.push("een deel kon niet gecontroleerd worden (de tempo-dienst reageerde niet)");
  if (scan.searchErrors) parts.push(`${scan.searchErrors} zoekopdrachten bij Spotify mislukten`);
  parts.push(breakdown(scan));
  setStatus(parts.join(" · "), scan.found.length ? "" : "error");
}

function renderResults() {
  const scan = state.scan;
  $("results").replaceChildren(
    ...state.results.map((c) => {
      const inList = state.playlist.items.some((i) => i.key === c.key);
      return h(
        "li",
        { class: "row" },
        cover(c.image),
        h("div", { class: "meta" }, h("strong", {}, c.title), h("span", {}, c.year ? `${c.artist} · ${c.year}` : c.artist)),
        h("div", { class: "bpm" }, `${c.bpm}`),
        h("button", { type: "button", class: "ghost", disabled: inList, onclick: () => addCandidate(c) }, inList ? "Toegevoegd" : "Toevoegen"),
      );
    }),
  );
  $("results-head").hidden = state.results.length === 0 && !(scan && scan.index < scan.candidates.length);
  $("add-top").disabled = state.results.length === 0;
  $("more-btn").hidden = !(scan && scan.index < scan.candidates.length);
}

function addCandidate(c) {
  addToPlaylist({ title: c.title, artist: c.artist, bpm: c.bpm, uri: c.uri, image: c.image, durationMs: c.durationMs });
}

// ---------- playlist ----------
function addToPlaylist(t) {
  if (!L.SPOTIFY_TRACK_URI.test(String(t.uri))) return false;
  const key = L.normKey(t.title, t.artist);
  if (state.playlist.items.some((i) => i.key === key)) return false;
  state.playlist.items.push({
    key,
    title: t.title,
    artist: t.artist,
    bpm: t.bpm ?? null,
    uri: t.uri,
    image: safeImage(t.image),
    durationMs: t.durationMs || 0,
  });
  renderPlaylist();
  saveDraft();
  return true;
}

function updateItems(items) {
  state.playlist.items = items;
  renderPlaylist();
  saveDraft();
}

function renderPlaylist() {
  const { items } = state.playlist;
  $("pl-list").replaceChildren(
    ...items.map((item, i) => {
      const row = h(
        "li",
        { class: "row", draggable: "true" },
        h("span", { class: "grip", "aria-hidden": "true" }, "⋮⋮"),
        cover(item.image),
        h("div", { class: "meta" }, h("strong", {}, item.title), h("span", {}, item.artist)),
        h("div", { class: "bpm" }, item.bpm != null ? `${item.bpm}` : "–"),
        h(
          "div",
          { class: "tools" },
          h("button", { type: "button", title: "Omhoog", "aria-label": `${item.title} omhoog`, disabled: i === 0, onclick: () => updateItems(L.moveItem(items, i, i - 1)) }, "↑"),
          h("button", { type: "button", title: "Omlaag", "aria-label": `${item.title} omlaag`, disabled: i === items.length - 1, onclick: () => updateItems(L.moveItem(items, i, i + 1)) }, "↓"),
          h("button", { type: "button", title: "Verwijderen", "aria-label": `${item.title} verwijderen`, onclick: () => updateItems(items.filter((_, n) => n !== i)) }, "✕"),
        ),
      );
      row.addEventListener("dragstart", (e) => {
        state.dragFrom = i;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(i));
      });
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        row.classList.add("drop-target");
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = state.dragFrom;
        state.dragFrom = -1;
        if (from >= 0) updateItems(L.moveItem(items, from, i));
      });
      return row;
    }),
  );

  const parts = [`${items.length} nummers`];
  if (items.length) parts.push(L.formatDuration(items.reduce((s, i) => s + i.durationMs, 0)));
  $("pl-summary").textContent = items.length ? parts.join(" · ") : "Nog geen nummers. Voeg ze toe via de zoekresultaten of zoek er zelf een.";
  if (state.results.length) renderResults();
}

// ---------- handmatig toevoegen ----------
async function onManualSearch(ev) {
  ev.preventDefault();
  const q = $("manual-q").value.trim();
  const box = $("manual-results");
  if (!q) return;
  box.replaceChildren(h("li", { class: "muted" }, "Zoeken…"));
  try {
    const token = S.getToken();
    if (!token) {
      updateConnection();
      throw new Error("Verbind eerst met Spotify (knop bovenaan de zoekkaart).");
    }
    const valid = await S.searchTracks(token, L.buildSearchQuery({ q }));
    box.replaceChildren(
      ...(valid.length
        ? valid.map((t) =>
            h(
              "li",
              { class: "row" },
              cover(t.image),
              h("div", { class: "meta" }, h("strong", {}, t.name), h("span", {}, `${t.artists.join(", ")} · ${t.album}`)),
              h(
                "button",
                {
                  type: "button",
                  class: "ghost",
                  onclick: () => {
                    addToPlaylist({ title: t.name, artist: t.artists[0] || "", bpm: null, uri: t.uri, image: t.image, durationMs: t.durationMs });
                    box.replaceChildren();
                    $("manual-q").value = "";
                  },
                },
                "Toevoegen",
              ),
            ),
          )
        : [h("li", { class: "muted" }, "Niets gevonden.")]),
    );
  } catch (err) {
    box.replaceChildren(h("li", { class: "msg error" }, `Zoeken mislukt: ${err.message}`));
  }
}

// ---------- export ----------
function showExport(kind, content, ...extra) {
  const box = $("export-result");
  if (!content) return box.replaceChildren();
  box.replaceChildren(h("div", { class: `msg ${kind}` }, content, ...extra));
}

const redirectUri = () => location.origin + location.pathname;

function connectToSpotify() {
  if (!CONFIG.SPOTIFY_CLIENT_ID || CONFIG.SPOTIFY_CLIENT_ID.startsWith("VUL_")) {
    return setStatus("Het Spotify Client ID is nog niet ingesteld in public/js/config.js.", "error");
  }
  S.startLogin(CONFIG.SPOTIFY_CLIENT_ID, redirectUri()).catch((err) => setStatus(err.message, "error"));
}

function disconnectSpotify() {
  S.clearToken();
  updateConnection();
  setStatus("Je bent losgekoppeld van Spotify.");
}

function updateConnection() {
  const connected = Boolean(S.getToken());
  $("connect-state").textContent = connected ? "Verbonden met Spotify" : "Niet verbonden met Spotify";
  $("connect-state").className = connected ? "connected" : "";
  $("connect-btn").hidden = connected;
  $("disconnect-btn").hidden = !connected;
}

async function onExport() {
  const items = state.playlist.items;
  if (!items.length) return showExport("error", "Er zijn nog geen nummers in de lijst.");
  const token = S.getToken();
  if (!token) {
    showExport("error", "Verbind eerst met Spotify met de knop 'Verbind met Spotify' bovenaan de zoekkaart. Daarna klik je opnieuw op Exporteer.");
    return;
  }
  $("export-btn").disabled = true;
  showExport("", "Playlist aanmaken op Spotify…");
  try {
    const res = await S.exportPlaylist(token, { name: state.playlist.name, uris: items.map((i) => i.uri) });
    const safeLink = res.url.startsWith("https://open.spotify.com/") ? res.url : "";
    showExport(
      "ok",
      `Klaar: ${res.count} nummers staan in je nieuwe (private) playlist. `,
      safeLink ? h("a", { href: safeLink, target: "_blank", rel: "noopener" }, "Open in Spotify") : null,
    );
  } catch (err) {
    showExport("error", err.message);
    updateConnection();
  } finally {
    $("export-btn").disabled = false;
  }
}

async function finishLoginIfReturning() {
  const params = new URLSearchParams(location.search);
  if (!params.has("code") && !params.has("error")) return;
  try {
    await S.completeLogin(CONFIG.SPOTIFY_CLIENT_ID, redirectUri());
    setStatus("Verbonden met Spotify. Je kunt nu nummers zoeken en je playlist exporteren.");
  } catch (err) {
    setStatus(err.message, "error");
  }
  updateConnection();
}

function downloadCsv() {
  const items = state.playlist.items;
  if (!items.length) return showExport("error", "Er zijn nog geen nummers om te downloaden.");
  const blob = new Blob(["﻿" + L.toCsv(items)], { type: "text/csv;charset=utf-8" });
  const a = h("a", { href: URL.createObjectURL(blob), download: (state.playlist.name || "playlist").replace(/[^\w\- ]+/g, "").trim() + ".csv" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- opstart ----------
function init() {
  setupYears();
  $("pl-name").value = state.playlist.name;
  $("search-form").addEventListener("submit", onSearch);
  $("manual-form").addEventListener("submit", onManualSearch);
  $("export-btn").addEventListener("click", onExport);
  $("csv-btn").addEventListener("click", downloadCsv);
  $("more-btn").addEventListener("click", () => continueScan(MORE_GOAL));
  $("stop-btn").addEventListener("click", () => {
    if (state.scan?.running) state.scan.stopped = true;
  });
  $("connect-btn").addEventListener("click", connectToSpotify);
  $("disconnect-btn").addEventListener("click", disconnectSpotify);
  $("pl-name").addEventListener("input", (e) => {
    state.playlist.name = e.target.value.slice(0, 100);
    saveDraft();
  });
  $("sort").addEventListener("change", (e) => {
    if (e.target.value) updateItems(L.sortTracks(state.playlist.items, e.target.value));
    e.target.value = "";
  });
  $("add-top").addEventListener("click", () => {
    for (const c of state.results.slice(0, 25)) addCandidate(c);
  });
  $("clear-btn").addEventListener("click", () => {
    if (state.playlist.items.length && confirm("Alle nummers uit de lijst verwijderen?")) updateItems([]);
  });
  S.onRateLimitWait((secs) => {
    if (state.scan?.running) setStatus(`Spotify vraagt om te vertragen, nieuwe poging over ${secs} s… · ${state.scan.found.length} gevonden · ${breakdown(state.scan)}`);
  });
  renderPlaylist();
  updateConnection();
  finishLoginIfReturning();
}

init();
