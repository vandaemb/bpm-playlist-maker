import { CONFIG } from "./config.js";
import * as L from "./logic.js";
import * as S from "./spotify.js";

const $ = (id) => document.getElementById(id);
const DRAFT_KEY = "bpm-playlist-draft-v1";
const FIRST_SHOW = 30;
const MORE_SHOW = 25;

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

// ---------- staat ----------
const state = { all: [], shown: 0, results: [], playlist: loadDraft(), dragFrom: -1 };

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

// ---------- zoeken in de lokale BPM-lijst ----------
// De lijst staat als bestanden op deze site (public/data, per blok van 10 BPM) en is een bewerking van
// "Almost a million Spotify tracks" (Zenodo, CC BY 4.0). Zoeken is dus een filter in de browser: geen
// externe aanvragen, geen limieten. Spotify is alleen nog nodig om de playlist aan te maken.
const dataCache = new Map();
function loadData(name) {
  if (!dataCache.has(name)) {
    const p = fetch(new URL(`/data/${name}.json`, location.origin)).then((res) => {
      if (!res.ok) throw new Error(`De lijst kon niet geladen worden (${name}, HTTP ${res.status}).`);
      return res.json();
    });
    p.catch(() => dataCache.delete(name));
    dataCache.set(name, p);
  }
  return dataCache.get(name);
}

async function onSearch(ev) {
  ev.preventDefault();
  const bpm = Number($("bpm").value);
  if (!Number.isFinite(bpm) || bpm < L.MIN_BPM || bpm > L.MAX_BPM) {
    return setStatus(`Kies een BPM tussen ${L.MIN_BPM} en ${L.MAX_BPM}.`, "error");
  }
  const tol = Number($("tol").value);
  const genre = $("genre").value.trim().slice(0, 40);
  const [from, to] = currentYears();
  $("search-btn").disabled = true;
  setStatus("Zoeken…");
  try {
    const [names, ...shards] = await Promise.all([loadData("genres"), ...L.dataBuckets(bpm, tol).map((b) => loadData(`bpm-${b}`))]);
    const genreSet = L.genreIndexSet(names, genre);
    state.all = [];
    state.shown = 0;
    state.results = [];
    if (genreSet && genreSet.size === 0) {
      setStatus(`Geen genre gevonden dat bij "${genre}" past. Probeer bv. pop, rock, hip hop, edm, jazz of laat het veld leeg.`, "error");
      return;
    }
    state.all = L.filterRows(shards.flat(), { bpm, tol, from, to, genreSet });
    state.shown = Math.min(FIRST_SHOW, state.all.length);
    state.results = state.all.slice(0, state.shown);
    setStatus(
      state.all.length
        ? `${state.all.length} nummers gevonden${state.shown < state.all.length ? `, de ${state.shown} populairste getoond` : ""}.`
        : "0 nummers gevonden. Probeer een grotere marge, een breder jaarbereik of een ander genre.",
      state.all.length ? "" : "error",
    );
  } catch (err) {
    setStatus(`Zoeken mislukt: ${err.message}`, "error");
  } finally {
    $("search-btn").disabled = false;
    renderResults();
  }
}

function showMore() {
  state.shown = Math.min(state.shown + MORE_SHOW, state.all.length);
  state.results = state.all.slice(0, state.shown);
  setStatus(`${state.all.length} nummers gevonden, ${state.shown} getoond.`);
  renderResults();
}

function renderResults() {
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
  $("results-head").hidden = state.results.length === 0;
  $("add-top").disabled = state.results.length === 0;
  $("more-btn").hidden = state.shown >= state.all.length;
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
  const totalMs = items.reduce((sum, i) => sum + i.durationMs, 0);
  if (items.length && totalMs > 0) parts.push(L.formatDuration(totalMs));
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
  $("more-btn").addEventListener("click", showMore);
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
  renderPlaylist();
  updateConnection();
  finishLoginIfReturning();
}

init();
