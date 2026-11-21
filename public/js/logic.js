// Pure logica: geen DOM, geen netwerk. Daardoor eenvoudig te testen met Node.

export const MIN_BPM = 40;
export const MAX_BPM = 220;

export const COUNTRY_CODES = [
  "BE", "NL", "FR", "DE", "GB", "IE", "LU", "CH", "AT", "ES", "PT", "IT", "DK", "SE", "NO", "FI",
  "PL", "CZ", "GR", "TR", "US", "CA", "MX", "BR", "AR", "CO", "CL", "AU", "NZ", "JP", "KR", "IN",
  "ZA", "NG", "MA", "EG",
];

// Alternatieve schrijfwijzen zoals ze in de "from"-velden van GetSongBPM kunnen voorkomen.
const COUNTRY_ALIASES = {
  GB: ["united kingdom", "uk", "england", "scotland", "wales", "northern ireland"],
  US: ["united states", "usa", "u.s.", "u.s.a."],
  NL: ["netherlands", "the netherlands", "holland"],
  CZ: ["czechia", "czech republic"],
  KR: ["south korea", "korea"],
};

const LASTFM_NAME_OVERRIDES = { CZ: "Czech Republic", KR: "Korea, Republic of" };

export function makeCountry(code, enName) {
  const en = String(enName || code);
  const names = new Set([stripDiacritics(en).toLowerCase(), ...(COUNTRY_ALIASES[code] || [])]);
  return { code, en: LASTFM_NAME_OVERRIDES[code] || en, names: [...names] };
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Alle gehele BPM-waarden binnen de tolerantie (max ±5, begrensd tot 40–220). */
export function bpmRange(center, tolerance) {
  const c = Math.round(Number(center));
  if (!Number.isFinite(c)) return [];
  const t = clamp(Math.round(Number(tolerance) || 0), 0, 5);
  const out = [];
  for (let b = c - t; b <= c + t; b++) if (b >= MIN_BPM && b <= MAX_BPM) out.push(b);
  return out;
}

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

/** GetSongBPM verpakt lijsten in een sleutel ({tempo:[...]}); soms is het direct een array. */
export function parseList(json, key) {
  if (Array.isArray(json)) return json;
  const v = json && json[key];
  return Array.isArray(v) ? v : [];
}

export function parseArtist(json) {
  const a = json && (json.artist ?? json);
  if (Array.isArray(a)) return a[0] ?? null;
  return a && typeof a === "object" ? a : null;
}

/** Zet een ruw tempo-object van GetSongBPM om naar ons eigen formaat. */
export function normalizeTempoItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const a = Array.isArray(raw.artist) ? raw.artist[0] : raw.artist;
  const artist = a && typeof a === "object" ? a : { name: a };
  const bpm = parseInt(raw.tempo, 10);
  const id = String(raw.song_id ?? raw.id ?? "");
  const title = String(raw.song_title ?? raw.title ?? "").trim();
  const artistName = String(artist.name ?? "").trim();
  if (!id || !title || !artistName || !Number.isFinite(bpm)) return null;
  return {
    id,
    title,
    artist: artistName,
    artistId: artist.id ? String(artist.id) : "",
    bpm,
    genres: Array.isArray(artist.genres) ? artist.genres.map(String) : [],
    from: String(artist.from ?? ""),
    hasArtistInfo: Array.isArray(artist.genres),
  };
}

export function withArtist(candidate, artistJson) {
  return {
    ...candidate,
    genres: Array.isArray(artistJson.genres) ? artistJson.genres.map(String) : candidate.genres,
    from: String(artistJson.from ?? candidate.from ?? ""),
    hasArtistInfo: true,
  };
}

function normGenre(s) {
  return stripDiacritics(s).toLowerCase().replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim();
}

export function genreMatches(genres, wanted) {
  const w = normGenre(wanted);
  if (!w) return true;
  return genres.some((g) => {
    const x = normGenre(g);
    return x && (x.includes(w) || w.includes(x));
  });
}

/** Maakt een opzoek-set van lokaal populaire nummers/artiesten (bv. Last.fm top van een land). */
export function buildLocalSet(tracks) {
  const trackKeys = new Set();
  const artists = new Set();
  for (const t of tracks || []) {
    if (!t || !t.name || !t.artist) continue;
    trackKeys.add(normKey(t.name, t.artist));
    artists.add(normText(t.artist));
  }
  return { trackKeys, artists };
}

/** 3 = artiest komt uit het land, 2 = nummer is er populair, 1 = artiest is er populair, 0 = geen link. */
export function locationScore(c, country, local) {
  const from = stripDiacritics(c.from).toLowerCase();
  if (country && from && country.names.some((n) => from.includes(n))) return 3;
  if (local) {
    if (local.trackKeys.has(normKey(c.title, c.artist))) return 2;
    if (local.artists.has(normText(c.artist))) return 1;
  }
  return 0;
}

export function rankCandidates(cands, { bpm, genre, country, local, strict }) {
  const scored = [];
  for (const c of cands) {
    if (genre && !genreMatches(c.genres, genre)) continue;
    const score = locationScore(c, country, local);
    if (strict && score === 0) continue;
    scored.push({ ...c, locScore: score });
  }
  const unique = dedupeBy(
    scored.sort((a, b) => b.locScore - a.locScore),
    (c) => normKey(c.title, c.artist),
  );
  return unique.sort(
    (a, b) =>
      b.locScore - a.locScore ||
      Math.abs(a.bpm - bpm) - Math.abs(b.bpm - bpm) ||
      a.title.localeCompare(b.title),
  );
}

export const SPOTIFY_TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;

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

export function toCsv(items) {
  const rows = [["Titel", "Artiest", "BPM", "Spotify-link"]];
  for (const t of items) {
    const id = t.uri ? t.uri.split(":")[2] : "";
    rows.push([t.title, t.artist, t.bpm ?? "", id ? `https://open.spotify.com/track/${id}` : ""]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
