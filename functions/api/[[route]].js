// Cloudflare Pages Function: de enige plek waar een geheim (de Last.fm-key) bestaat.
// De browser praat alleen met deze proxy (zelfde domein) voor Last.fm en tempo (ReccoBeats).
// Spotify wordt rechtstreeks vanuit de browser aangeroepen met de eigen token van de gebruiker.
//
// Vereiste omgevingsvariabele (Pages > Settings > Variables and secrets):
//   LASTFM_KEY
// ReccoBeats (tempo/BPM) vraagt geen key.

const RECCO = "https://api.reccobeats.com/v1";
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

// ---- Deezer: reserve voor nummers waarvoor ReccoBeats niets (of niets bruikbaars) geeft. ----
const DEEZER = "https://api.deezer.com";
const MAX_NAME = 120;
const DEEZER_CONCURRENCY = 4;

function normName(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function deezerJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!res.ok) throw new Upstream(res.status, "Deezer");
  const body = await res.json();
  if (body?.error) throw new Upstream("fout", "Deezer");
  return body;
}

/**
 * Zoekt een nummer op Deezer op artiest + titel.
 * { ok:false } = Deezer gaf een fout (niets afleiden); anders { ok:true, found, tempo, year, isrc }.
 */
async function deezerInfo(artist, title) {
  const none = { ok: true, found: false, tempo: null, year: null, isrc: "" };
  try {
    const wa = normName(artist);
    const wt = normName(title);
    if (!wa || !wt) return none;
    const found = await deezerJson(`${DEEZER}/search?${new URLSearchParams({ q: `${artist} ${title}`.slice(0, 150), limit: "5" })}`);
    const hit = (Array.isArray(found?.data) ? found.data : []).find((t) => {
      const ta = normName(t?.title);
      const aa = normName(t?.artist?.name);
      return aa && (ta === wt || ta.startsWith(wt) || wt.startsWith(ta)) && (wa.includes(aa) || aa.includes(wa));
    });
    if (!hit || !Number.isInteger(hit.id)) return none;
    const track = await deezerJson(`${DEEZER}/track/${hit.id}`);
    const bpm = Number(track?.bpm);
    const year = /^(\d{4})-/.exec(String(track?.release_date ?? ""));
    const isrc = /^[A-Z0-9]{12}$/.test(String(track?.isrc ?? "")) ? track.isrc : "";
    return { ok: true, found: true, tempo: Number.isFinite(bpm) && bpm > 0 ? bpm : null, year: year ? Number(year[1]) : null, isrc };
  } catch {
    return { ok: false };
  }
}

async function deezerTempo(artist, title) {
  const r = await deezerInfo(artist, title);
  return r.ok ? { ok: true, tempo: r.tempo } : { ok: false };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const DAY = 86400;

/**
 * Tempo per Spotify-ID: eerst de cache, dan ReccoBeats (één aanvraag voor alles), en voor wat daar
 * ontbreekt (of als ReccoBeats faalt) Deezer op artiest + titel. `names` = { id: {artist, title} }.
 */
async function tempoFor(ids, names, waitUntil) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const tempos = {};
  const missing = [];
  for (const id of ids) {
    const hit = cache ? await cache.match(tempoKey(id)) : null;
    if (hit) tempos[id] = (await hit.json()).tempo;
    else missing.push(id);
  }
  if (!missing.length) return tempos;

  const store = (id, tempo, ttl) => {
    if (cache) waitUntil(cache.put(tempoKey(id), new Response(JSON.stringify({ tempo }), { headers: { "cache-control": `public, max-age=${ttl}` } })));
  };

  // 1. ReccoBeats
  const found = {};
  let reccoError = null;
  try {
    const res = await upstreamFetch(`${RECCO}/audio-features?${new URLSearchParams({ ids: missing.join(",") })}`, {
      headers: { accept: "application/json" },
    }, "ReccoBeats");
    const body = await res.json();
    const list = Array.isArray(body) ? body : Array.isArray(body?.content) ? body.content : [];
    for (const f of list) {
      const m = /track\/([A-Za-z0-9]{22})/.exec(String(f?.href ?? ""));
      const t = Number(f?.tempo);
      if (m && Number.isFinite(t)) found[m[1]] = t;
    }
  } catch (err) {
    if (!(err instanceof Upstream)) throw err;
    reccoError = err;
  }

  // 2. Deezer voor de rest (alleen als we namen kennen)
  const rest = missing.filter((id) => !Object.hasOwn(found, id) && names[id]);
  const deezer = {};
  const answers = await mapLimit(rest, DEEZER_CONCURRENCY, (id) => deezerTempo(names[id].artist, names[id].title));
  rest.forEach((id, i) => (deezer[id] = answers[i]));

  let inconclusive = false;
  for (const id of missing) {
    if (Object.hasOwn(found, id)) {
      tempos[id] = found[id];
      store(id, found[id], 7 * DAY);
    } else if (deezer[id]?.ok && deezer[id].tempo != null) {
      tempos[id] = deezer[id].tempo;
      store(id, deezer[id].tempo, 7 * DAY);
    } else if (deezer[id] && !deezer[id].ok) {
      inconclusive = true; // Deezer-fout: niets onthouden
      tempos[id] = null;
    } else if (reccoError) {
      if (names[id] && deezer[id]?.ok) {
        tempos[id] = null; // ReccoBeats faalde, Deezer weet het niet: later opnieuw proberen
        store(id, null, 3600);
      } else {
        inconclusive = true;
        tempos[id] = null;
      }
    } else {
      tempos[id] = null; // ReccoBeats antwoordde zonder tempo (en Deezer ook niet, of geen naam)
      store(id, null, DAY);
    }
  }
  // ReccoBeats faalde en we konden niet alles zeker bepalen: de browser moet later opnieuw proberen.
  if (reccoError && inconclusive) throw reccoError;
  return tempos;
}

// ---- Handlers: geven { ttl, data } terug. ttl 0 = niet cachen op URL-niveau. ----
const handlers = {
  async tempo(params, env, waitUntil) {
    const ids = (params.get("ids") || "").split(",").filter(Boolean);
    if (!ids.length || ids.length > MAX_IDS || !ids.every((i) => SPOTIFY_ID.test(i))) {
      throw new BadRequest("Ongeldige parameter: ids");
    }
    // Optionele namen (parallel aan ids), voor de Deezer-reserve.
    const artists = params.getAll("a");
    const titles = params.getAll("t");
    const names = {};
    if (artists.length || titles.length) {
      const ok = (v) => v.length <= MAX_NAME && !/[\u0000-\u001f\u007f]/.test(v);
      if (artists.length !== ids.length || titles.length !== ids.length || !artists.every(ok) || !titles.every(ok)) {
        throw new BadRequest("Ongeldige parameter: a/t");
      }
      ids.forEach((id, i) => {
        if (!names[id]) names[id] = { artist: artists[i], title: titles[i] };
      });
    }
    return { ttl: 0, data: { tempos: await tempoFor([...new Set(ids)], names, waitUntil) } };
  },

  // Deezer-gegevens (BPM, jaar, ISRC) voor tot 20 nummers, parallel aan elkaar (a = artiesten, t = titels).
  async deezer(params, env, waitUntil) {
    const artists = params.getAll("a");
    const titles = params.getAll("t");
    const ok = (v) => v.length > 0 && v.length <= MAX_NAME && !/[\u0000-\u001f\u007f]/.test(v);
    if (!artists.length || artists.length > MAX_IDS || artists.length !== titles.length || !artists.every(ok) || !titles.every(ok)) {
      throw new BadRequest("Ongeldige parameter: a/t");
    }
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const keyFor = (a, t) => new Request(`https://cache.internal/dz/${encodeURIComponent(normName(a))}/${encodeURIComponent(normName(t))}`);
    const items = await mapLimit(artists.map((a, i) => [a, titles[i]]), DEEZER_CONCURRENCY, async ([a, t]) => {
      const key = keyFor(a, t);
      const hit = cache ? await cache.match(key) : null;
      if (hit) return hit.json();
      const info = await deezerInfo(a, t);
      if (!info.ok) return { ok: false };
      const out = { ok: true, found: info.found, tempo: info.tempo, year: info.year, isrc: info.isrc };
      if (cache) waitUntil(cache.put(key, new Response(JSON.stringify(out), { headers: { "cache-control": `public, max-age=${info.tempo ? 7 * DAY : DAY}` } })));
      return out;
    });
    if (items.every((i) => !i.ok)) throw new Upstream("fout", "Deezer");
    return { ttl: 0, data: { items } };
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
    const page = intParam(params, "page", 1, 10);
    return lastfmTracks("tag.gettoptracks", { tag, page: String(page) }, env);
  },

  async chart(params, env) {
    const page = intParam(params, "page", 1, 3);
    return lastfmTracks("chart.gettoptracks", { page: String(page) }, env);
  },
};

const NO_URL_CACHE = new Set(["tempo", "deezer"]);

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
