import { CONFIG } from "./config.js";
import * as L from "./logic.js";
import * as S from "./spotify.js";

const $ = (id) => document.getElementById(id);
const DRAFT_KEY = "bpm-playlist-draft-v1";
const PENDING_KEY = "bpm-playlist-pending-export";
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
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
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

// ---------- staat ----------
const state = { results: [], resultsCountry: null, scan: null, scanId: 0, playlist: loadDraft(), dragFrom: -1, countries: [] };

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

// ---------- landen ----------
function setupCountries() {
  const nl = new Intl.DisplayNames(["nl"], { type: "region" });
  const en = new Intl.DisplayNames(["en"], { type: "region" });
  state.countries = L.COUNTRY_CODES.map((code) => ({ ...L.makeCountry(code, en.of(code)), label: nl.of(code) })).sort((a, b) =>
    a.label.localeCompare(b.label, "nl"),
  );
  const select = $("country");
  for (const c of state.countries) select.append(h("option", { value: c.code }, c.label));
  const guess = (navigator.language || "").split("-")[1]?.toUpperCase();
  select.value = state.countries.some((c) => c.code === guess) ? guess : "BE";
}

const currentCountry = () => state.countries.find((c) => c.code === $("country").value) || state.countries[0];

// ---------- zoeken ----------
// Stappen: (1) kandidaten uit Last.fm (land en/of genre), (2) per kandidaat het echte nummer op
// Spotify zoeken, (3) het tempo van die nummers opvragen (ReccoBeats), (4) filteren op BPM.
// Dat gebeurt in rondes van 20, zodat de eerste resultaten snel verschijnen.
async function fetchLastfm(path, params, pages) {
  const settled = await Promise.allSettled(Array.from({ length: pages }, (_, i) => api(path, { ...params, page: i + 1 })));
  return settled.filter((r) => r.status === "fulfilled").flatMap((r) => r.value.tracks || []);
}

async function fetchTempos(ids) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return (await api("/api/tempo", { ids: ids.join(",") })).tempos || {};
    } catch (err) {
      if (attempt === 0) await sleep(1500);
      else throw err;
    }
  }
  return {};
}

async function onSearch(ev) {
  ev.preventDefault();
  const bpm = Number($("bpm").value);
  if (!Number.isFinite(bpm) || bpm < L.MIN_BPM || bpm > L.MAX_BPM) {
    return setStatus(`Kies een BPM tussen ${L.MIN_BPM} en ${L.MAX_BPM}.`, "error");
  }
  const tol = Number($("tol").value);
  const genre = $("genre").value.trim().slice(0, 40);
  const country = currentCountry();
  const abroad = $("abroad").checked;

  const id = ++state.scanId;
  state.scan = null;
  state.results = [];
  state.resultsCountry = country;
  renderResults();
  $("search-btn").disabled = true;
  try {
    setStatus(`Populaire muziek in ${country.label}${genre ? ` en genre "${genre}"` : ""} ophalen…`);
    const [countryTracks, genreTracks, globalTracks] = await Promise.all([
      fetchLastfm("/api/lastfm", { country: country.en }, 5),
      genre ? fetchLastfm("/api/lastfm-tag", { tag: genre }, 5) : [],
      !genre && abroad ? fetchLastfm("/api/chart", {}, 3) : [],
    ]);
    if (!countryTracks.length && !genreTracks.length) throw new Error("Last.fm gaf geen nummers terug. Probeer het later opnieuw.");
    const local = L.buildLocalSet(countryTracks);
    const candidates = L.buildPool({ local, countryTracks, genreTracks, globalTracks, genre, abroad });
    if (!candidates.length) {
      return setStatus(
        genre
          ? "Geen nummers gevonden die in dit genre én in jouw land populair zijn. Vink 'ook buiten mijn land' aan of kies een ander genre."
          : "Geen kandidaten gevonden.",
        "error",
      );
    }
    state.scan = { id, candidates, index: 0, bpm, tol, country, found: [], keys: new Set(), running: false, failedBatches: 0 };
    await continueScan(FIRST_GOAL);
  } catch (err) {
    setStatus(`Zoeken mislukt: ${err.message}`, "error");
  } finally {
    $("search-btn").disabled = false;
  }
}

async function continueScan(extra) {
  const scan = state.scan;
  if (!scan || scan.running) return;
  scan.running = true;
  $("search-btn").disabled = true;
  $("more-btn").disabled = true;
  const goal = scan.found.length + extra;
  try {
    while (scan.found.length < goal && scan.index < scan.candidates.length && scan.id === state.scanId) {
      const batch = scan.candidates.slice(scan.index, scan.index + BATCH);
      scan.index += batch.length;
      setStatus(`Zoeken… ${scan.index} van ${scan.candidates.length} nummers gecontroleerd · ${scan.found.length} gevonden`);

      const looked = await pool(batch, 4, async (c) => {
        const { tracks } = await api("/api/search", { title: c.title, artist: c.artist });
        const best = L.pickBestMatch(tracks, c);
        return best ? { c, best, spotifyId: L.spotifyIdFromUri(best.uri) } : null;
      });
      if (scan.id !== state.scanId) return;
      const matched = looked.filter((r) => r.ok && r.value).map((r) => r.value);
      if (!matched.length) continue;

      let tempos = {};
      try {
        tempos = await fetchTempos([...new Set(matched.map((m) => m.spotifyId))]);
      } catch {
        scan.failedBatches++;
        continue;
      }
      if (scan.id !== state.scanId) return;
      for (const m of matched) {
        const tempo = tempos[m.spotifyId];
        if (!L.tempoMatches(tempo, scan.bpm, scan.tol)) continue;
        const title = m.best.name;
        const artist = m.best.artists[0] || m.c.artist;
        const key = L.normKey(title, artist);
        if (scan.keys.has(key)) continue;
        scan.keys.add(key);
        scan.found.push({
          key,
          title,
          artist,
          bpm: Math.round(tempo),
          uri: m.best.uri,
          image: safeImage(m.best.image),
          durationMs: m.best.durationMs,
          locScore: m.c.locScore,
        });
      }
      state.results = scan.found;
      renderResults();
    }
  } catch (err) {
    if (scan.id === state.scanId) setStatus(`Zoeken mislukt: ${err.message}`, "error");
    return;
  } finally {
    scan.running = false;
    if (scan.id === state.scanId) {
      $("search-btn").disabled = false;
      $("more-btn").disabled = false;
      renderResults();
    }
  }
  if (scan.id !== state.scanId) return;

  const exhausted = scan.index >= scan.candidates.length;
  const parts = [`${scan.found.length} nummers gevonden`];
  parts.push(exhausted ? "alle kandidaten zijn gecontroleerd" : `${scan.index} van ${scan.candidates.length} gecontroleerd, klik op "Meer zoeken" voor meer`);
  if (!scan.found.length && exhausted) parts.push("probeer een grotere marge, een ander genre of vink 'ook buiten mijn land' aan");
  if (scan.failedBatches) parts.push("een deel kon niet gecontroleerd worden (de tempo-dienst reageerde niet)");
  setStatus(parts.join(" · "), scan.found.length ? "" : "error");
}

function localBadge(score, country) {
  if (score === 2) return h("span", { class: "badge local" }, `populair in ${country.label}`);
  if (score === 1) return h("span", { class: "badge" }, `artiest populair in ${country.label}`);
  return null;
}

function renderResults() {
  const country = state.resultsCountry;
  const scan = state.scan;
  $("results").replaceChildren(
    ...state.results.map((c) => {
      const inList = state.playlist.items.some((i) => i.key === c.key);
      return h(
        "li",
        { class: "row" },
        cover(c.image),
        h("div", { class: "meta" }, h("strong", {}, c.title), h("span", {}, c.artist, country ? localBadge(c.locScore, country) : null)),
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
    const { tracks } = await api("/api/search", { q });
    const valid = tracks.filter((t) => L.SPOTIFY_TRACK_URI.test(String(t.uri)));
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

async function onExport() {
  const items = state.playlist.items;
  if (!CONFIG.SPOTIFY_CLIENT_ID || CONFIG.SPOTIFY_CLIENT_ID.startsWith("VUL_")) {
    return showExport("error", "Het Spotify Client ID is nog niet ingesteld in public/js/config.js.");
  }
  if (!items.length) return showExport("error", "Er zijn nog geen nummers in de lijst.");
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ name: state.playlist.name, uris: items.map((i) => i.uri) }));
    showExport("", "Je gaat naar Spotify om toestemming te geven…");
    await S.startLogin(CONFIG.SPOTIFY_CLIENT_ID, redirectUri());
  } catch (err) {
    showExport("error", err.message);
  }
}

async function finishExportIfReturning() {
  const params = new URLSearchParams(location.search);
  if (!params.has("code") && !params.has("error")) return;
  let pending = null;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null");
  } catch {}
  sessionStorage.removeItem(PENDING_KEY);
  try {
    const token = await S.completeLogin(CONFIG.SPOTIFY_CLIENT_ID, redirectUri());
    if (!pending || !Array.isArray(pending.uris)) throw new Error("Er was geen playlist om te exporteren. Probeer opnieuw.");
    showExport("", "Playlist aanmaken op Spotify…");
    const res = await S.exportPlaylist(token, { name: String(pending.name || ""), uris: pending.uris.map(String) });
    const safeLink = res.url.startsWith("https://open.spotify.com/") ? res.url : "";
    showExport(
      "ok",
      `Klaar: ${res.count} nummers staan in je nieuwe (private) playlist. `,
      safeLink ? h("a", { href: safeLink, target: "_blank", rel: "noopener" }, "Open in Spotify") : null,
    );
  } catch (err) {
    showExport("error", err.message);
  }
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
  setupCountries();
  $("pl-name").value = state.playlist.name;
  $("search-form").addEventListener("submit", onSearch);
  $("manual-form").addEventListener("submit", onManualSearch);
  $("export-btn").addEventListener("click", onExport);
  $("csv-btn").addEventListener("click", downloadCsv);
  $("more-btn").addEventListener("click", () => continueScan(MORE_GOAL));
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
  renderPlaylist();
  finishExportIfReturning();
}

init();
