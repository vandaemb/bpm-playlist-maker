// Pure logica: geen DOM, geen netwerk. Daardoor eenvoudig te testen met Node.

export const MIN_BPM = 40;
export const MAX_BPM = 220;

export const COUNTRY_CODES = [
  "BE", "NL", "FR", "DE", "GB", "IE", "LU", "CH", "AT", "ES", "PT", "IT", "DK", "SE", "NO", "FI",
  "PL", "CZ", "GR", "TR", "US", "CA", "MX", "BR", "AR", "CO", "CL", "AU", "NZ", "JP", "KR", "IN",
  "ZA", "NG", "MA", "EG",
];

const LASTFM_NAME_OVERRIDES = { CZ: "Czech Republic", KR: "Korea, Republic of" };

/** Last.fm verwacht Engelse landnamen. */
export function makeCountry(code, enName) {
  return { code, en: LASTFM_NAME_OVERRIDES[code] || String(enName || code) };
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

/** Valt het gemeten tempo binnen de gekozen BPM ± marge? */
export function tempoMatches(tempo, bpm, tolerance) {
  const t = Number(tempo);
  if (tempo == null || !Number.isFinite(t)) return false;
  return Math.abs(Math.round(t) - Math.round(bpm)) <= Math.max(0, Number(tolerance) || 0);
}

/** Opzoek-set van lokaal populaire nummers/artiesten (bv. Last.fm top van een land). */
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

/** 2 = nummer is populair in het land, 1 = artiest is er populair, 0 = geen link. */
export function locationScore(c, local) {
  if (!local) return 0;
  if (local.trackKeys.has(normKey(c.title, c.artist))) return 2;
  if (local.artists.has(normText(c.artist))) return 1;
  return 0;
}

/**
 * Stelt de kandidatenlijst samen die we daarna op Spotify zoeken en op tempo controleren.
 * - Zonder genre: de top van het land (en optioneel de wereldwijde top).
 * - Met genre: de top van dat genre; zonder "ook buiten mijn land" blijven alleen nummers/artiesten
 *   over die ook in het land populair zijn.
 */
export function buildPool({ local, countryTracks = [], genreTracks = [], globalTracks = [], genre, abroad }) {
  const base = genre ? genreTracks : abroad ? [...countryTracks, ...globalTracks] : countryTracks;
  const items = dedupeBy(
    base.filter((t) => t && t.name && t.artist).map((t) => ({ title: t.name, artist: t.artist })),
    (c) => normKey(c.title, c.artist),
  );
  const scored = items.map((c) => ({ ...c, locScore: locationScore(c, local) }));
  const kept = genre && !abroad ? scored.filter((c) => c.locScore > 0) : scored;
  // Array.prototype.sort is stabiel: binnen dezelfde score blijft de Last.fm-volgorde (populariteit) behouden.
  return kept.sort((a, b) => b.locScore - a.locScore);
}

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

export function toCsv(items) {
  const rows = [["Titel", "Artiest", "BPM", "Spotify-link"]];
  for (const t of items) {
    const id = spotifyIdFromUri(t.uri);
    rows.push([t.title, t.artist, t.bpm ?? "", id ? `https://open.spotify.com/track/${id}` : ""]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
