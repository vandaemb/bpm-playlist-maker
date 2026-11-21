import { CONFIG } from "./config.js";
import * as L from "./logic.js";
import * as S from "./spotify.js";

const $ = (id) => document.getElementById(id);
const DRAFT_KEY = "bpm-playlist-draft-v1";
const PENDING_KEY = "bpm-playlist-pending-export";

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
const state = { results: [], playlist: loadDraft(), dragFrom: -1, countries: [] };

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
        status: "ok",
      }));
    return { name: String(d.name || "Mijn BPM-playlist").slice(0, 100), items };
  } catch {
    return { name: "Mijn BPM-playlist", items: [] };
  }
}

function saveDraft() {
  try {
    const items = state.playlist.items.filter((i) => i.status === "ok");
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ name: state.playlist.name, items }));
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
async function onSearch(ev) {
  ev.preventDefault();
  const bpm = Number($("bpm").value);
  if (!Number.isFinite(bpm) || bpm < L.MIN_BPM || bpm > L.MAX_BPM) {
    return setStatus(`Kies een BPM tussen ${L.MIN_BPM} en ${L.MAX_BPM}.`, "error");
  }
  const tol = Number($("tol").value);
  const genre = $("genre").value.trim().slice(0, 40);
  const country = currentCountry();
  const strict = $("strict").checked;

  $("search-btn").disabled = true;
  $("results").replaceChildren();
  $("results-head").hidden = true;
  try {
    setStatus("Nummers met dit tempo ophalen…");
    const values = L.bpmRange(bpm, tol);
    const tempoRes = await pool(values, 4, (v) => api("/api/tempo", { bpm: v }));
    const good = tempoRes.filter((r) => r.ok);
    if (!good.length) throw tempoRes[0].error;

    let cands = L.dedupeBy(
      good.flatMap((r) => L.parseList(r.value, "tempo")).map(L.normalizeTempoItem).filter(Boolean),
      (c) => c.id,
    );

    // Ontbreken genre/herkomst in de tempo-lijst, dan vragen we die per artiest op (max 120).
    const missing = [...new Set(cands.filter((c) => !c.hasArtistInfo && c.artistId).map((c) => c.artistId))];
    const capped = missing.slice(0, 120);
    if (capped.length) {
      const arts = await pool(capped, 4, (id, i) => {
        setStatus(`Artiesten controleren… (${i + 1}/${capped.length})`);
        return api("/api/artist", { id });
      });
      const byId = new Map();
      arts.forEach((r, i) => {
        const a = r.ok ? L.parseArtist(r.value) : null;
        if (a) byId.set(capped[i], a);
      });
      cands = cands.map((c) => (byId.has(c.artistId) ? L.withArtist(c, byId.get(c.artistId)) : c));
    }

    setStatus(`Lokale populariteit in ${country.label} ophalen…`);
    let local = null;
    let localFailed = false;
    try {
      const pages = await Promise.all([1, 2, 3].map((page) => api("/api/lastfm", { country: country.en, page })));
      local = L.buildLocalSet(pages.flatMap((p) => p.tracks || []));
    } catch {
      localFailed = true;
    }

    state.results = L.rankCandidates(cands, { bpm, genre, country, local, strict }).slice(0, 100);
    renderResults(country);

    const parts = [`${state.results.length} nummers gevonden`];
    if (!state.results.length) parts.push("probeer een grotere marge, een ander genre of zet de landfilter uit");
    if (missing.length > capped.length) parts.push(`slechts ${capped.length} van ${missing.length} artiesten gecontroleerd`);
    if (localFailed) parts.push("lokale populariteit was niet beschikbaar");
    setStatus(parts.join(" · "), state.results.length ? "" : "error");
  } catch (err) {
    setStatus(`Zoeken mislukt: ${err.message}`, "error");
  } finally {
    $("search-btn").disabled = false;
  }
}

function localBadge(score, country) {
  if (score === 3) return h("span", { class: "badge local" }, `uit ${country.label}`);
  if (score === 2) return h("span", { class: "badge local" }, `populair in ${country.label}`);
  if (score === 1) return h("span", { class: "badge" }, `artiest populair in ${country.label}`);
  return null;
}

function renderResults(country) {
  const list = $("results");
  list.replaceChildren(
    ...state.results.map((c) => {
      const key = L.normKey(c.title, c.artist);
      const inList = state.playlist.items.some((i) => i.key === key);
      return h(
        "li",
        { class: "row" },
        h("div", { class: "meta" }, h("strong", {}, c.title), h("span", {}, c.artist, localBadge(c.locScore, country))),
        h("div", { class: "bpm" }, `${c.bpm}`),
        h("button", { type: "button", class: "ghost", disabled: inList, onclick: () => addCandidate(c) }, inList ? "Toegevoegd" : "Toevoegen"),
      );
    }),
  );
  $("results-head").hidden = state.results.length === 0;
  state.resultsCountry = country;
}

function addCandidate(c) {
  addToPlaylist({ title: c.title, artist: c.artist, bpm: c.bpm });
  renderResults(state.resultsCountry);
}

// ---------- Spotify-matching op de achtergrond ----------
const queue = [];
let active = 0;

function queueResolve(item) {
  queue.push(item);
  pump();
}

function pump() {
  while (active < 3 && queue.length) {
    const item = queue.shift();
    active++;
    resolveItem(item).finally(() => {
      active--;
      pump();
    });
  }
}

async function resolveItem(item) {
  item.status = "pending";
  try {
    const { tracks } = await api("/api/search", { title: item.title, artist: item.artist });
    const best = L.pickBestMatch(tracks, item);
    if (best) {
      Object.assign(item, { uri: best.uri, image: safeImage(best.image), durationMs: best.durationMs, status: "ok" });
    } else {
      item.status = "missing";
    }
  } catch {
    item.status = "error";
  }
  renderPlaylist();
  saveDraft();
}

// ---------- playlist ----------
function addToPlaylist(t) {
  const key = L.normKey(t.title, t.artist);
  if (state.playlist.items.some((i) => i.key === key)) return false;
  const item = {
    key,
    title: t.title,
    artist: t.artist,
    bpm: t.bpm ?? null,
    uri: t.uri || null,
    image: t.image ? safeImage(t.image) : "",
    durationMs: t.durationMs || 0,
    status: t.uri ? "ok" : "pending",
  };
  state.playlist.items.push(item);
  if (!t.uri) queueResolve(item);
  renderPlaylist();
  saveDraft();
  return true;
}

function updateItems(items) {
  state.playlist.items = items;
  renderPlaylist();
  saveDraft();
}

function statusBadge(item) {
  if (item.status === "pending") return h("span", { class: "badge" }, "zoeken op Spotify…");
  if (item.status === "missing") return h("span", { class: "badge warn" }, "niet gevonden op Spotify");
  if (item.status === "error") return h("span", { class: "badge warn" }, "zoeken mislukt");
  return null;
}

function renderPlaylist() {
  const { items } = state.playlist;
  const list = $("pl-list");
  list.replaceChildren(
    ...items.map((item, i) => {
      const row = h(
        "li",
        { class: "row", draggable: "true" },
        h("span", { class: "grip", "aria-hidden": "true" }, "⋮⋮"),
        cover(item.image),
        h("div", { class: "meta" }, h("strong", {}, item.title), h("span", {}, item.artist, statusBadge(item))),
        h("div", { class: "bpm" }, item.bpm != null ? `${item.bpm}` : "–"),
        h(
          "div",
          { class: "tools" },
          item.status === "error" || item.status === "missing"
            ? h("button", { type: "button", title: "Opnieuw zoeken", "aria-label": `Zoek ${item.title} opnieuw`, onclick: () => queueResolve(item) }, "↻")
            : null,
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

  const ok = items.filter((i) => i.status === "ok");
  const pending = items.filter((i) => i.status === "pending").length;
  const bad = items.filter((i) => i.status === "missing" || i.status === "error").length;
  const parts = [`${items.length} nummers`];
  if (ok.length) parts.push(L.formatDuration(ok.reduce((s, i) => s + i.durationMs, 0)));
  if (pending) parts.push(`${pending} nog te zoeken`);
  if (bad) parts.push(`${bad} niet exporteerbaar`);
  $("pl-summary").textContent = items.length ? parts.join(" · ") : "Nog geen nummers. Voeg ze toe via de zoekresultaten of zoek er zelf een.";
  if (state.results.length) renderResults(state.resultsCountry);
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
  const { items } = state.playlist;
  const ok = items.filter((i) => i.status === "ok" && i.uri);
  if (!CONFIG.SPOTIFY_CLIENT_ID || CONFIG.SPOTIFY_CLIENT_ID.startsWith("VUL_")) {
    return showExport("error", "Het Spotify Client ID is nog niet ingesteld in public/js/config.js.");
  }
  if (items.some((i) => i.status === "pending")) {
    return showExport("error", "Even geduld: sommige nummers worden nog op Spotify gezocht.");
  }
  if (!ok.length) return showExport("error", "Er zijn nog geen exporteerbare nummers in de lijst.");
  try {
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ name: state.playlist.name, uris: ok.map((i) => i.uri), skipped: items.length - ok.length }),
    );
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
    if (pending.skipped) $("export-result").append(h("p", { class: "muted small" }, `${pending.skipped} nummers zonder Spotify-match zijn overgeslagen.`));
  } catch (err) {
    showExport("error", err.message);
  }
}

function downloadCsv() {
  const items = state.playlist.items.filter((i) => i.status === "ok");
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
  $("pl-name").addEventListener("input", (e) => {
    state.playlist.name = e.target.value.slice(0, 100);
    saveDraft();
  });
  $("sort").addEventListener("change", (e) => {
    if (e.target.value) updateItems(L.sortTracks(state.playlist.items, e.target.value));
    e.target.value = "";
  });
  $("add-top").addEventListener("click", () => {
    for (const c of state.results.slice(0, 25)) addToPlaylist({ title: c.title, artist: c.artist, bpm: c.bpm });
    renderResults(state.resultsCountry);
  });
  $("clear-btn").addEventListener("click", () => {
    if (state.playlist.items.length && confirm("Alle nummers uit de lijst verwijderen?")) updateItems([]);
  });
  renderPlaylist();
  finishExportIfReturning();
}

init();
