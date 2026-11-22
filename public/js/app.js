import * as L from "./logic.js";
import { t, apply, setLang } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const DRAFT_KEY = "bpm-playlist-draft-v1";
const MAX_ADD_ALL = 1000;
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
    return { items };
  } catch {
    return { items: [] };
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
  const [lo, hi] = bpmRange();
  const bpm = (lo + hi) / 2;
  const tol = (hi - lo) / 2;
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
    state.all = L.filterRows(shards.flat(), { bpm, tol, lo, hi, from, to, genreSet, excludeSet });
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
  $("add-all").disabled = state.all.length === 0;
  $("more-btn").hidden = state.shown >= state.all.length;
}

function addCandidate(c, quiet = false) {
  return addToPlaylist({ title: c.title, artist: c.artist, bpm: c.bpm, uri: c.uri, image: c.image, durationMs: c.durationMs }, quiet);
}

// ---------- playlist ----------
function addToPlaylist(t, quiet = false) {
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
  if (!quiet) {
    renderPlaylist();
    saveDraft();
  }
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

async function copyLinks() {
  const ids = state.playlist.items.map((i) => L.spotifyIdFromUri(i.uri)).filter(Boolean);
  if (!ids.length) return showExport("error", "exp.emptyCsv");
  try {
    await navigator.clipboard.writeText(ids.map((id) => `https://open.spotify.com/track/${id}`).join("\n"));
    showExport("ok", "copy.done", { n: ids.length });
  } catch {
    showExport("error", "copy.fail");
  }
}

function downloadCsv() {
  const items = state.playlist.items;
  if (!items.length) return showExport("error", "exp.emptyCsv");
  const blob = new Blob(["﻿" + L.toCsv(items, [t("csv.title"), t("csv.artist"), "BPM", t("csv.link")])], { type: "text/csv;charset=utf-8" });
  const a = h("a", { href: URL.createObjectURL(blob), download: "bpm-playlist.csv" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- opstart ----------
// Alles wat de taal raakt opnieuw tekenen, zonder de pagina te herladen.
function rerender() {
  apply();
  if (lastStatus) setStatus(lastStatus.key, lastStatus.kind, lastStatus.params);
  renderExport();
  renderPlaylist();
  renderResults();
}

const bpmRange = () => [Number($("bpm-lo").value), Number($("bpm-hi").value)];

// Twee handvatten op één schuif: de gekleurde band is het gekozen tempobereik (dus de marge).
function setupTempo() {
  const lo = $("bpm-lo");
  const hi = $("bpm-hi");
  const min = Number(lo.min);
  const max = Number(lo.max);
  const draw = (moved) => {
    let a = Number(lo.value);
    let b = Number(hi.value);
    if (a > b) {
      if (moved === "lo") b = a;
      else a = b;
      lo.value = String(a);
      hi.value = String(b);
    }
    $("dual").style.setProperty("--lo", `${((a - min) / (max - min)) * 100}%`);
    $("dual").style.setProperty("--hi", `${((b - min) / (max - min)) * 100}%`);
    $("bpm-label").textContent = a === b ? `${a}` : `${a} – ${b}`;
    for (const c of document.querySelectorAll("#presets .chip")) {
      const m = Number(c.dataset.bpm);
      c.setAttribute("aria-pressed", String(a === m - 3 && b === m + 3));
    }
    // het handvat dat het laatst bewogen is, komt bovenaan zodat beide bereikbaar blijven
    if (moved === "lo") { lo.style.zIndex = "2"; hi.style.zIndex = "1"; }
    if (moved === "hi") { hi.style.zIndex = "2"; lo.style.zIndex = "1"; }
  };
  lo.addEventListener("input", () => draw("lo"));
  hi.addEventListener("input", () => draw("hi"));
  for (const c of document.querySelectorAll("#presets .chip")) {
    c.addEventListener("click", () => {
      const m = Number(c.dataset.bpm);
      lo.value = String(Math.max(min, m - 3));
      hi.value = String(Math.min(max, m + 3));
      draw();
    });
  }
  draw();
}

function init() {
  setupYears();
  setupTempo();
  for (const b of document.querySelectorAll("[data-lang]")) b.addEventListener("click", () => setLang(b.dataset.lang) && rerender());
  $("search-form").addEventListener("submit", onSearch);
  $("csv-btn").addEventListener("click", downloadCsv);
  $("copy-btn").addEventListener("click", copyLinks);
  $("more-btn").addEventListener("click", showMore);
  $("sort").addEventListener("change", (e) => {
    if (e.target.value) updateItems(L.sortTracks(state.playlist.items, e.target.value));
    e.target.value = "";
  });
  $("add-top").addEventListener("click", () => {
    for (const c of state.results.slice(0, 25)) addCandidate(c);
  });
  $("add-all").addEventListener("click", () => {
    let added = 0;
    for (const c of state.all.slice(0, MAX_ADD_ALL)) if (addCandidate(c, true)) added++;
    renderPlaylist();
    saveDraft();
    setStatus("st.addedAll", "", { n: added });
  });
  $("clear-btn").addEventListener("click", () => {
    if (state.playlist.items.length && confirm(t("confirm.clear"))) updateItems([]);
  });
  apply();
  renderPlaylist();
}

init();
