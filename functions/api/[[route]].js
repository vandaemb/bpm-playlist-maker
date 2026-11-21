// Cloudflare Pages Function: de enige plek waar geheimen (API-keys) bestaan.
// De browser praat alleen met deze proxy (zelfde domein). Het Spotify client secret en de
// Last.fm-key komen nooit in de browser.
//
// Vereiste omgevingsvariabelen (Pages > Settings > Variables and secrets):
//   LASTFM_KEY, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET
// ReccoBeats (tempo/BPM) vraagt geen key.

const RECCO = "https://api.reccobeats.com/v1";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API = "https://api.spotify.com/v1";
const LASTFM = "https://ws.audioscrobbler.com/2.0/";
const UPSTREAM_TIMEOUT_MS = 8000;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const MAX_IDS = 20;

class BadRequest extends Error {}
class Misconfigured extends Error {}
class Upstream extends Error {
  constructor(status, label = "") {
    super(String(status));
    this.status = String(status);
    this.label = label;
  }
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", ...extra },
  });
}

function need(env, name) {
  if (!env[name]) throw new Misconfigured(name);
  return env[name];
}

async function upstreamFetch(url, init = {}, label = "") {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch {
    throw new Upstream("geen antwoord", label);
  }
  if (!res.ok) throw new Upstream(res.status, label);
  return res;
}

// ---- Spotify app-token (client credentials). Alleen voor zoeken; geen gebruikersdata. ----
let spotifyToken = { value: null, expires: 0 };

async function getSpotifyToken(env) {
  if (spotifyToken.value && Date.now() < spotifyToken.expires - 30_000) return spotifyToken.value;
  const basic = btoa(`${need(env, "SPOTIFY_CLIENT_ID")}:${need(env, "SPOTIFY_CLIENT_SECRET")}`);
  const res = await upstreamFetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  }, "Spotify-aanmelding");
  const data = await res.json();
  spotifyToken = { value: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return spotifyToken.value;
}

// ---- Invoervalidatie: alles wat doorgegeven wordt aan een externe dienst wordt strikt gecontroleerd. ----
function intParam(params, name, lo, hi) {
  const raw = params.get(name);
  if (!raw || !/^\d{1,4}$/.test(raw)) throw new BadRequest(`Ongeldige parameter: ${name}`);
  const n = Number(raw);
  if (n < lo || n > hi) throw new BadRequest(`Ongeldige parameter: ${name}`);
  return n;
}

function textParam(params, name, max) {
  const raw = (params.get(name) || "").trim();
  if (!raw || raw.length > max) throw new BadRequest(`Ongeldige parameter: ${name}`);
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new BadRequest(`Ongeldige parameter: ${name}`);
  return raw;
}

function spotifyTerm(s) {
  // Haalt tekens weg die de Spotify-zoeksyntax kunnen verstoren, en (remaster)-achtervoegels.
  return s.replace(/\(.*?\)|\[.*?\]/g, " ").replace(/["':\\]/g, " ").replace(/\s+/g, " ").trim();
}

// ---- Last.fm ----
async function lastfmTracks(method, extra, env) {
  const url = `${LASTFM}?${new URLSearchParams({
    method,
    ...extra,
    limit: "50",
    api_key: need(env, "LASTFM_KEY"),
    format: "json",
  })}`;
  const d = await (await upstreamFetch(url, {}, "Last.fm")).json();
  const list = Array.isArray(d?.tracks?.track) ? d.tracks.track : [];
  const tracks = list
    .map((t) => ({ name: String(t?.name ?? ""), artist: String(t?.artist?.name ?? "") }))
    .filter((t) => t.name && t.artist);
  return { ttl: 86400, data: { tracks } };
}

// ---- Tempo (ReccoBeats): per Spotify-ID gecachet, zodat herhaalde zoekopdrachten niets kosten. ----
const tempoKey = (id) => new Request(`https://cache.internal/tempo/${id}`);

async function tempoFor(ids, waitUntil) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const tempos = {};
  const missing = [];
  for (const id of ids) {
    const hit = cache ? await cache.match(tempoKey(id)) : null;
    if (hit) tempos[id] = (await hit.json()).tempo;
    else missing.push(id);
  }
  if (missing.length) {
    const res = await upstreamFetch(`${RECCO}/audio-features?${new URLSearchParams({ ids: missing.join(",") })}`, {
      headers: { accept: "application/json" },
    }, "ReccoBeats");
    const body = await res.json();
    const list = Array.isArray(body) ? body : Array.isArray(body?.content) ? body.content : [];
    const found = {};
    for (const f of list) {
      const m = /track\/([A-Za-z0-9]{22})/.exec(String(f?.href ?? ""));
      const t = Number(f?.tempo);
      if (m && Number.isFinite(t)) found[m[1]] = t;
    }
    for (const id of missing) {
      const tempo = Object.hasOwn(found, id) ? found[id] : null;
      tempos[id] = tempo;
      if (cache) {
        const ttl = tempo === null ? 86400 : 7 * 86400;
        waitUntil(cache.put(tempoKey(id), new Response(JSON.stringify({ tempo }), { headers: { "cache-control": `public, max-age=${ttl}` } })));
      }
    }
  }
  return tempos;
}

// ---- Handlers: geven { ttl, data } terug. ttl 0 = niet cachen op URL-niveau. ----
const handlers = {
  async tempo(params, env, waitUntil) {
    const ids = (params.get("ids") || "").split(",").filter(Boolean);
    if (!ids.length || ids.length > MAX_IDS || !ids.every((i) => SPOTIFY_ID.test(i))) {
      throw new BadRequest("Ongeldige parameter: ids");
    }
    return { ttl: 0, data: { tempos: await tempoFor([...new Set(ids)], waitUntil) } };
  },

  async lastfm(params, env) {
    const country = textParam(params, "country", 60);
    if (!/^[A-Za-z][A-Za-z .,'()-]*$/.test(country)) throw new BadRequest("Ongeldige parameter: country");
    const page = intParam(params, "page", 1, 5);
    return lastfmTracks("geo.gettoptracks", { country, page: String(page) }, env);
  },

  async "lastfm-tag"(params, env) {
    const tag = textParam(params, "tag", 40);
    if (!/^[\p{L}\p{N} &'+.\-]+$/u.test(tag)) throw new BadRequest("Ongeldige parameter: tag");
    const page = intParam(params, "page", 1, 5);
    return lastfmTracks("tag.gettoptracks", { tag, page: String(page) }, env);
  },

  async chart(params, env) {
    const page = intParam(params, "page", 1, 3);
    return lastfmTracks("chart.gettoptracks", { page: String(page) }, env);
  },

  async search(params, env) {
    let q;
    if (params.has("title")) {
      const title = spotifyTerm(textParam(params, "title", 120));
      const artist = spotifyTerm(textParam(params, "artist", 120));
      if (!title || !artist) throw new BadRequest("Ongeldige parameter: title/artist");
      q = `track:${title} artist:${artist}`;
    } else {
      q = spotifyTerm(textParam(params, "q", 100));
      if (!q) throw new BadRequest("Ongeldige parameter: q");
    }
    const token = await getSpotifyToken(env);
    const res = await upstreamFetch(`${SPOTIFY_API}/search?${new URLSearchParams({ q, type: "track", limit: "5" })}`, {
      headers: { Authorization: `Bearer ${token}` },
    }, "Spotify-zoeken");
    const d = await res.json();
    const items = Array.isArray(d?.tracks?.items) ? d.tracks.items : [];
    const tracks = items
      .filter((t) => t && typeof t.uri === "string")
      .map((t) => {
        const images = t.album?.images || [];
        return {
          uri: t.uri,
          name: String(t.name ?? ""),
          artists: (t.artists || []).map((a) => String(a?.name ?? "")),
          album: String(t.album?.name ?? ""),
          image: images.length ? images[Math.min(1, images.length - 1)].url : "",
          durationMs: Number(t.duration_ms) || 0,
        };
      });
    return { ttl: 6 * 3600, data: { tracks } };
  },
};

const NO_URL_CACHE = new Set(["tempo"]);

// Blokkeert andere websites die jouw proxy (en dus jouw API-quota) willen meebenutten.
// Browsers sturen Sec-Fetch-Site mee en dat kan een pagina niet vervalsen.
function isForeignBrowserRequest(request) {
  const site = request.headers.get("Sec-Fetch-Site");
  return site !== null && site !== "same-origin" && site !== "none";
}

export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;
  try {
    if (isForeignBrowserRequest(request)) return json({ error: "Niet toegestaan." }, 403);

    const url = new URL(request.url);
    const name = url.pathname.replace(/^\/api\//, "").replace(/\/+$/, "");
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : null;
    if (!handler) return json({ error: "Onbekende route." }, 404);

    const useCache = !NO_URL_CACHE.has(name) && typeof caches !== "undefined";
    const cacheKey = new Request(url.toString(), { method: "GET" });
    if (useCache) {
      const hit = await caches.default.match(cacheKey);
      if (hit) return hit;
    }

    const { ttl, data } = await handler(url.searchParams, env, waitUntil);
    const response = json(data, 200, { "cache-control": ttl ? `public, max-age=${ttl}` : "no-store" });
    if (useCache && ttl) waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    if (err instanceof Misconfigured) return json({ error: `Server niet geconfigureerd: ${err.message} ontbreekt.` }, 500);
    if (err instanceof Upstream) {
      const rate = err.status === "429" ? " (limiet bereikt, probeer het later opnieuw)" : "";
      const who = err.label ? ` (${err.label}, HTTP ${err.status})` : "";
      return json({ error: `De externe muziekdienst gaf een fout${who}${rate}.` }, 502);
    }
    return json({ error: "Onverwachte serverfout." }, 500);
  }
}

export function onRequest() {
  return json({ error: "Alleen GET is toegestaan." }, 405, { allow: "GET" });
}
