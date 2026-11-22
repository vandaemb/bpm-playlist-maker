import { CONFIG } from "./config.js";
import * as L from "./logic.js";
import * as S from "./spotify.js";
import { t, apply, setLang, getLang, allValues } from "./i18n.js";

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
    return { name: String(d.name || "").slice(0, 100), items };
  } catch {
    return { name: "", items: [] };
  }
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(state.playlist));
  } catch {}
}

// Meldingen worden als sleutel bewaard zodat ze meteen meewisselen als de taal verandert.
let lastStatus = null;
function setStatus(key, kind = "", params = {}) {
  lastStatus = { key, kind, params };
  const el = $("status");
  el.textContent = key ? t(key, params) : "";
  el.className = kind;
}
function setStatusRaw(text, kind = "") {
  lastStatus = null;
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
      if (!res.ok) throw new Error(t("err.load", { name, status: res.status }));
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
    return setStatus("st.bpmRange", "error", { min: L.MIN_BPM, max: L.MAX_BPM });
  }
  const tol = Number($("tol").value);
  const genre = $("genre").value.trim().slice(0, 60);
  const [from, to] = currentYears();
  $("search-btn").disabled = true;
  setStatus("st.searching");
  try {
    const [names, ...shards] = await Promise.all([loadData("genres"), ...L.dataBuckets(bpm, tol).map((b) => loadData(`bpm-${b}`))]);
    const { include: genreSet, exclude: excludeSet } = L.genreFilter(names, genre);
    state.all = [];
    state.shown = 0;
    state.results = [];
    if (genreSet && genreSet.size === 0) {
      setStatus("st.noGenre", "error", { genre });
      return;
    }
    state.all = L.filterRows(shards.flat(), { bpm, tol, from, to, genreSet, excludeSet });
    state.shown = Math.min(FIRST_SHOW, state.all.length);
    state.results = state.all.slice(0, state.shown);
    if (!state.all.length) setStatus("st.none", "error");
    else if (state.shown < state.all.length) setStatus("st.foundShown", "", { n: state.all.length, shown: state.shown });
    else setStatus("st.found", "", { n: state.all.length });
  } catch (err) {
    setStatus("st.failed", "error", { msg: err.message });
  } finally {
    $("search-btn").disabled = false;
    renderResults();
  }
}

function showMore() {
  state.shown = Math.min(state.shown + MORE_SHOW, state.all.length);
  state.results = state.all.slice(0, state.shown);
  setStatus("st.shown", "", { n: state.all.length, shown: state.shown });
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
        h("button", { type: "button", class: "ghost", disabled: inList, onclick: () => addCandidate(c) }, inList ? t("results.added") : t("results.add")),
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
          h("button", { type: "button", title: t("pl.up"), "aria-label": t("pl.upAria", { title: item.title }), disabled: i === 0, onclick: () => updateItems(L.moveItem(items, i, i - 1)) }, "↑"),
          h("button", { type: "button", title: t("pl.down"), "aria-label": t("pl.downAria", { title: item.title }), disabled: i === items.length - 1, onclick: () => updateItems(L.moveItem(items, i, i + 1)) }, "↓"),
          h("button", { type: "button", title: t("pl.remove"), "aria-label": t("pl.removeAria", { title: item.title }), onclick: () => updateItems(items.filter((_, n) => n !== i)) }, "✕"),
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

  const parts = [t("pl.count", { n: items.length })];
  const totalMs = items.reduce((sum, i) => sum + i.durationMs, 0);
  if (items.length && totalMs > 0) parts.push(L.formatDuration(totalMs));
  $("pl-summary").textContent = items.length ? parts.join(" · ") : t("pl.empty");
  if (state.results.length) renderResults();
}

// ---------- handmatig toevoegen ----------
async function onManualSearch(ev) {
  ev.preventDefault();
  const q = $("manual-q").value.trim();
  const box = $("manual-results");
  if (!q) return;
  box.replaceChildren(h("li", { class: "muted" }, t("manual.searching")));
  try {
    const token = S.getToken();
    if (!token) {
      updateConnection();
      throw new Error(t("exp.connectFirst"));
    }
    const valid = await S.searchTracks(token, L.buildSearchQuery({ q }));
    box.replaceChildren(
      ...(valid.length
        ? valid.map((tr) =>
            h(
              "li",
              { class: "row" },
              cover(tr.image),
              h("div", { class: "meta" }, h("strong", {}, tr.name), h("span", {}, `${tr.artists.join(", ")} · ${tr.album}`)),
              h(
                "button",
                {
                  type: "button",
                  class: "ghost",
                  onclick: () => {
                    addToPlaylist({ title: tr.name, artist: tr.artists[0] || "", bpm: null, uri: tr.uri, image: tr.image, durationMs: tr.durationMs });
                    box.replaceChildren();
                    $("manual-q").value = "";
                  },
                },
                t("results.add"),
              ),
            ),
          )
        : [h("li", { class: "muted" }, t("manual.none"))]),
    );
  } catch (err) {
    box.replaceChildren(h("li", { class: "msg error" }, t("manual.failed", { msg: err.message })));
  }
}

// ---------- export ----------
let lastExport = null;
function showExport(kind, key, params = {}, link = "") {
  lastExport = key ? { kind, key, params, link } : null;
  renderExport();
}
function showExportRaw(kind, text) {
  lastExport = { kind, raw: text };
  renderExport();
}
function renderExport() {
  const box = $("export-result");
  if (!lastExport) return box.replaceChildren();
  const { kind, key, params, raw, link } = lastExport;
  box.replaceChildren(
    h("div", { class: `msg ${kind}` }, raw ?? t(key, params), link ? [" ", h("a", { href: link, target: "_blank", rel: "noopener" }, t("exp.open"))] : null),
  );
}

const redirectUri = () => location.origin + location.pathname;

function connectToSpotify() {
  if (!CONFIG.SPOTIFY_CLIENT_ID || CONFIG.SPOTIFY_CLIENT_ID.startsWith("VUL_")) {
    return setStatus("err.clientId", "error");
  }
  S.startLogin(CONFIG.SPOTIFY_CLIENT_ID, redirectUri()).catch((err) => setStatusRaw(err.message, "error"));
}

function disconnectSpotify() {
  S.clearToken();
  updateConnection();
  setStatus("st.disconnected");
}

function updateConnection() {
  const connected = Boolean(S.getToken());
  $("connect-state").textContent = t(connected ? "conn.on" : "conn.off");
  $("connect-state").className = connected ? "connected" : "";
  $("connect-btn").hidden = connected;
  $("disconnect-btn").hidden = !connected;
}

async function onExport() {
  const items = state.playlist.items;
  if (!items.length) return showExport("error", "exp.empty");
  const token = S.getToken();
  if (!token) {
    return showExport("error", "exp.connectFirst");
  }
  $("export-btn").disabled = true;
  showExport("", "exp.creating");
  try {
    const res = await S.exportPlaylist(token, { name: state.playlist.name || t("pl.defaultName"), uris: items.map((i) => i.uri) });
    const safeLink = res.url.startsWith("https://open.spotify.com/") ? res.url : "";
    showExport("ok", "exp.done", { n: res.count }, safeLink);
  } catch (err) {
    showExportRaw("error", err.message);
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
    setStatus("st.connected");
  } catch (err) {
    setStatusRaw(err.message, "error");
  }
  updateConnection();
}

function downloadCsv() {
  const items = state.playlist.items;
  if (!items.length) return showExport("error", "exp.emptyCsv");
  const blob = new Blob(["﻿" + L.toCsv(items, [t("csv.title"), t("csv.artist"), "BPM", t("csv.link")])], { type: "text/csv;charset=utf-8" });
  const a = h("a", { href: URL.createObjectURL(blob), download: (state.playlist.name || t("pl.defaultName")).replace(/[^\w\- ]+/g, "").trim() + ".csv" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- opstart ----------
const DEFAULT_NAMES = allValues("pl.defaultName");

// Alles wat de taal raakt opnieuw tekenen, zonder de pagina te herladen.
function rerender() {
  apply();
  const nameEl = $("pl-name");
  if (!state.playlist.name || DEFAULT_NAMES.includes(state.playlist.name)) {
    state.playlist.name = t("pl.defaultName");
    nameEl.value = state.playlist.name;
  }
  if (lastStatus) setStatus(lastStatus.key, lastStatus.kind, lastStatus.params);
  renderExport();
  renderPlaylist();
  renderResults();
  updateConnection();
}

function setupTempo() {
  const bpm = $("bpm");
  const mark = () => {
    for (const c of document.querySelectorAll("#presets .chip")) c.setAttribute("aria-pressed", String(Number(c.dataset.bpm) === Number(bpm.value)));
  };
  const step = (d) => {
    const v = Math.min(L.MAX_BPM, Math.max(L.MIN_BPM, (Number(bpm.value) || 120) + d));
    bpm.value = String(v);
    mark();
  };
  $("bpm-dec").addEventListener("click", () => step(-1));
  $("bpm-inc").addEventListener("click", () => step(1));
  bpm.addEventListener("input", mark);
  for (const c of document.querySelectorAll("#presets .chip")) {
    c.addEventListener("click", () => {
      bpm.value = c.dataset.bpm;
      mark();
    });
  }
  mark();
}

function init() {
  setupYears();
  setupTempo();
  for (const b of document.querySelectorAll("[data-lang]")) b.addEventListener("click", () => setLang(b.dataset.lang) && rerender());
  if (!state.playlist.name) state.playlist.name = t("pl.defaultName");
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
    if (state.playlist.items.length && confirm(t("confirm.clear"))) updateItems([]);
  });
  apply();
  renderPlaylist();
  updateConnection();
  finishLoginIfReturning();
}

init();
