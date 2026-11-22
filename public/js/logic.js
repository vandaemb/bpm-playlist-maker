// Pure logica: geen DOM, geen netwerk. Daardoor eenvoudig te testen met Node.

export const MIN_BPM = 40;
export const MAX_BPM = 220;

export function stripDiacritics(s) {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Normaliseert tekst voor vergelijkingen (zonder accenten, tussen haakjes, feat. ...). */
export function normText(s) {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\b(feat|ft|featuring|with)\b.*$/, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normKey(title, artist) {
  return `${normText(title)}|${normText(artist)}`;
}

export function dedupeBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/** Valt het gemeten tempo binnen de gekozen BPM ± marge? */
export function tempoMatches(tempo, bpm, tolerance) {
  const t = Number(tempo);
  if (tempo == null || !Number.isFinite(t)) return false;
  return Math.abs(Math.round(t) - Math.round(bpm)) <= Math.max(0, Number(tolerance) || 0);
}

export const MIN_YEAR = 1950;

/** Jaartal uit een Spotify-releasedatum ("1999", "1999-05" of "1999-05-21"), anders null. */
export function releaseYear(date) {
  const m = /^(\d{4})(?:-\d{2}(?:-\d{2})?)?$/.exec(String(date ?? ""));
  return m ? Number(m[1]) : null;
}

/** Valt het jaar binnen het gekozen bereik (beide grenzen inbegrepen)? */
export function yearMatches(year, from, to) {
  if (!Number.isInteger(year)) return false;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return year >= lo && year <= hi;
}

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
export const SPOTIFY_TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;

export function spotifyIdFromUri(uri) {
  return SPOTIFY_TRACK_URI.test(String(uri)) ? String(uri).split(":")[2] : "";
}

/** Kiest uit Spotify-zoekresultaten het nummer dat echt overeenkomt, anders null. */
export function pickBestMatch(tracks, item) {
  const wantTitle = normText(item.title);
  const wantArtist = normText(item.artist);
  for (const t of tracks || []) {
    if (!t || !SPOTIFY_TRACK_URI.test(String(t.uri))) continue;
    const gotTitle = normText(t.name);
    const titleOk = gotTitle === wantTitle || gotTitle.startsWith(wantTitle) || wantTitle.startsWith(gotTitle);
    const artistOk = (t.artists || []).some((a) => {
      const g = normText(a);
      return g && (wantArtist.includes(g) || g.includes(wantArtist));
    });
    if (titleOk && artistOk) return t;
  }
  return null;
}

function searchTerm(s) {
  // Haalt tekens weg die de Spotify-zoeksyntax kunnen verstoren, en (remaster)-achtervoegsels.
  return String(s ?? "").replace(/\(.*?\)|\[.*?\]/g, " ").replace(/["':\\]/g, " ").replace(/\s+/g, " ").trim();
}

/** Zoekopdracht voor Spotify: op titel + artiest, of vrije tekst. */
export function buildSearchQuery({ title, artist, q }) {
  if (title != null) {
    const t = searchTerm(title).slice(0, 120);
    const a = searchTerm(artist).slice(0, 120);
    return t && a ? `track:${t} artist:${a}` : "";
  }
  return searchTerm(q).slice(0, 100);
}

/** Zet een Spotify-zoekantwoord om naar een slank formaat. */
export function mapSpotifyTracks(data) {
  const items = Array.isArray(data?.tracks?.items) ? data.tracks.items : [];
  return items
    .filter((t) => t && typeof t.uri === "string" && SPOTIFY_TRACK_URI.test(t.uri))
    .map((t) => {
      const images = t.album?.images || [];
      return {
        uri: t.uri,
        name: String(t.name ?? ""),
        artists: (t.artists || []).map((a) => String(a?.name ?? "")),
        album: String(t.album?.name ?? ""),
        image: images.length ? String(images[Math.min(1, images.length - 1)].url ?? "") : "",
        durationMs: Number(t.duration_ms) || 0,
        year: releaseYear(t.album?.release_date),
      };
    });
}

export function moveItem(arr, from, to) {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr.slice();
  const copy = arr.slice();
  const [x] = copy.splice(from, 1);
  copy.splice(to, 0, x);
  return copy;
}

export function sortTracks(tracks, mode, rand = Math.random) {
  const copy = tracks.slice();
  const text = (a, b) => String(a).localeCompare(String(b), "nl", { sensitivity: "base" });
  const bpmVal = (t, dir) => (t.bpm == null ? Infinity : dir * t.bpm);
  switch (mode) {
    case "title":
      return copy.sort((a, b) => text(a.title, b.title));
    case "title-desc":
      return copy.sort((a, b) => text(b.title, a.title));
    case "artist":
      return copy.sort((a, b) => text(a.artist, b.artist) || text(a.title, b.title));
    case "bpm-asc":
      return copy.sort((a, b) => bpmVal(a, 1) - bpmVal(b, 1));
    case "bpm-desc":
      return copy.sort((a, b) => bpmVal(a, -1) - bpmVal(b, -1));
    case "shuffle":
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    default:
      return copy;
  }
}

export function formatDuration(ms) {
  const total = Math.round((ms || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}u ${String(m).padStart(2, "0")}m` : `${m}:${String(s).padStart(2, "0")}`;
}

function csvCell(v) {
  let s = String(v ?? "");
  // Voorkomt CSV-formule-injectie wanneer het bestand in Excel wordt geopend.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(items, header = ["Titel", "Artiest", "BPM", "Spotify-link"]) {
  const rows = [header];
  for (const t of items) {
    const id = spotifyIdFromUri(t.uri);
    rows.push([t.title, t.artist, t.bpm ?? "", id ? `https://open.spotify.com/track/${id}` : ""]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}


// ---------- lokale BPM-lijst (public/data) ----------
export const DATA_BUCKET = 10;
export const DATA_MIN = 40;
export const DATA_MAX = 210;

/** Bestanden (begin van elk blok van 10 BPM) die nodig zijn voor bpm ± tol. */
export function dataBuckets(bpm, tol) {
  const lo = Math.max(DATA_MIN, Math.floor((bpm - tol) / DATA_BUCKET) * DATA_BUCKET);
  const hi = Math.min(DATA_MAX, Math.floor((bpm + tol) / DATA_BUCKET) * DATA_BUCKET);
  const out = [];
  for (let b = lo; b <= hi; b += DATA_BUCKET) out.push(b);
  return out;
}

/**
 * Leest de genre-invoer met operators:
 *   "pop, rock"   -> pop OF rock (komma, | of het woord "or")
 *   "dance pop"   -> beide woorden moeten in dezelfde tag staan
 *   "pop -rap"    -> pop, maar geen rap (ook "pop not rap")
 * Geeft { terms: [[woord, ...], ...], not: [woord, ...] }.
 */
export function parseGenreQuery(query) {
  const terms = [];
  const not = [];
  const pieces = String(query ?? "").toLowerCase().split(/\s*(?:,|\||\bor\b)\s*/);
  for (const piece of pieces) {
    const words = [];
    let negate = false;
    for (const tok of piece.split(/\s+/).filter(Boolean)) {
      if (tok === "not") { negate = true; continue; }
      const neg = negate || (tok.length > 1 && tok.startsWith("-"));
      const w = normText(tok.replace(/^-+/, ""));
      negate = false;
      if (!w) continue;
      (neg ? not : words).push(w);
    }
    if (words.length) terms.push(words);
  }
  return { terms, not };
}

/**
 * Welke genre-tags (indexen in genres.json) passen bij wat de gebruiker typte?
 * Geeft { include: Set | null, exclude: Set } (include null = geen genrefilter).
 * Elk woord van een term moet in de tag voorkomen; een uitgesloten woord moet als heel woord in de tag staan.
 */
export function genreFilter(names, query) {
  const { terms, not } = parseGenreQuery(query);
  const exclude = new Set();
  let include = null;
  if (terms.length) include = new Set();
  if (!terms.length && !not.length) return { include: null, exclude };
  names.forEach((name, i) => {
    const n = normText(name);
    if (include && terms.some((ws) => ws.every((w) => n.includes(w)))) include.add(i);
    if (not.length) {
      const parts = n.split(" ");
      if (not.some((w) => parts.includes(w))) exclude.add(i);
    }
  });
  return { include, exclude };
}

/** Oudere vorm: alleen de include-set (null = geen filter). */
export function genreIndexSet(names, query) {
  return genreFilter(names, query).include;
}

/**
 * Filtert rijen [id, titel, artiest, bpm, jaar, populariteit, [genre-indexen]] op tempo, jaar en genre.
 * Sorteert op populariteit (hoogste eerst), daarna op afstand tot het gevraagde tempo.
 */
export function filterRows(rows, { bpm, tol, from, to, genreSet, excludeSet }) {
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const [id, title, artist, tempo, year, popularity, genres] = r;
    if (!SPOTIFY_ID.test(String(id)) || !tempoMatches(tempo, bpm, tol) || !yearMatches(year, from, to)) continue;
    if (genreSet && !genres.some((g) => genreSet.has(g))) continue;
    if (excludeSet && excludeSet.size && genres.some((g) => excludeSet.has(g))) continue;
    const key = normKey(title, artist);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, title, artist, bpm: Math.round(tempo), year, popularity, uri: `spotify:track:${id}`, image: "", durationMs: 0, distance: Math.abs(tempo - bpm) });
  }
  return out.sort((a, b) => b.popularity - a.popularity || a.distance - b.distance);
}
