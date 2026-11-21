// Spotify-koppeling zonder eigen login en zonder client secret.
// OAuth Authorization Code + PKCE: de gebruiker logt in op de pagina van Spotify zelf.
// Deze site ziet nooit een wachtwoord. De toegangstoken (max. 1 uur geldig) wordt alleen bewaard in
// sessionStorage van deze browsertab en verdwijnt zodra de tab sluit of de gebruiker de verbinding verbreekt.

import { mapSpotifyTracks } from "./logic.js";

const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";
const SCOPES = "playlist-modify-private playlist-modify-public";
const VERIFIER_KEY = "pkce_verifier";
const STATE_KEY = "pkce_state";
const TOKEN_KEY = "spotify_token";
const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;

/** Fout waarbij opnieuw proberen niets helpt (verlopen verbinding of geen toegang). */
export class SpotifyAuthError extends Error {}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return b64url(bytes).slice(0, len);
}

export async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

// ---- token in sessionStorage ----
export function getToken() {
  try {
    const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || "null");
    if (t && typeof t.value === "string" && t.value && Date.now() < Number(t.expires)) return t.value;
  } catch {}
  sessionStorage.removeItem(TOKEN_KEY);
  return "";
}

export function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

function saveToken(value, expiresIn) {
  const seconds = Math.max(60, (Number(expiresIn) || 3600) - 120);
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ value, expires: Date.now() + seconds * 1000 }));
}

// ---- inloggen ----
export async function startLogin(clientId, redirectUri) {
  const verifier = randomString(96);
  const state = randomString(32);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge_method: "S256",
    code_challenge: await challengeFor(verifier),
  }).toString();
  location.assign(url.toString());
}

function cleanUrl() {
  history.replaceState(null, "", location.pathname);
}

/** Verwerkt de terugkeer van Spotify, bewaart de token en geeft hem terug. Gooit een fout bij problemen. */
export async function completeLogin(clientId, redirectUri) {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  const savedState = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  cleanUrl();

  if (error) {
    throw new Error(error === "access_denied" ? "Je hebt de toegang tot Spotify geweigerd." : `Spotify meldde een fout: ${error}`);
  }
  if (!code || !verifier || !state || state !== savedState) {
    throw new Error("De Spotify-aanmelding kon niet worden bevestigd. Probeer opnieuw.");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error("Spotify gaf geen toegang (token-aanvraag mislukt).");
  const data = await res.json();
  if (!data.access_token) throw new Error("Spotify gaf geen toegangstoken terug.");
  saveToken(data.access_token, data.expires_in);
  return data.access_token;
}

// ---- API-aanroepen met de token van de gebruiker ----
const FORBIDDEN_MESSAGE =
  "Spotify weigert toegang (403). Controleer of de eigenaar van de Spotify-app een actief Premium-abonnement heeft " +
  "en of jouw account is toegevoegd bij 'User management' in het Spotify Developer Dashboard (maximaal 5 gebruikers).";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function spotifyFetch(token, path, init = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(API + path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
    });
    if (res.status === 429 && attempt === 0) {
      await sleep(Math.min(5, Number(res.headers.get("Retry-After")) || 1) * 1000);
      continue;
    }
    if (res.status === 401) {
      clearToken();
      throw new SpotifyAuthError("Je Spotify-verbinding is verlopen. Verbind opnieuw met Spotify.");
    }
    if (res.status === 403) throw new SpotifyAuthError(FORBIDDEN_MESSAGE);
    if (res.status === 429) throw new Error("Spotify vraagt om even te wachten (te veel aanvragen). Probeer het zo opnieuw.");
    if (!res.ok) throw new Error(`Spotify-fout ${res.status}.`);
    return res.json();
  }
  throw new Error("Spotify vraagt om even te wachten. Probeer het zo opnieuw.");
}

/** Zoekt nummers op Spotify (max. 5). Geeft een slank formaat terug. */
export async function searchTracks(token, query) {
  if (!query) return [];
  return mapSpotifyTracks(await spotifyFetch(token, `/search?${new URLSearchParams({ q: query, type: "track", limit: "5" })}`));
}

/** Maakt de (private) playlist aan en voegt de nummers toe in blokken van 100. */
export async function exportPlaylist(token, { name, uris }) {
  const cleanName = String(name || "Mijn BPM-playlist").slice(0, 100);
  const unique = [...new Set(uris)].filter((u) => TRACK_URI.test(u));
  if (!unique.length) throw new Error("Er zijn geen geldige nummers om te exporteren.");

  const playlist = await spotifyFetch(token, "/me/playlists", {
    method: "POST",
    body: JSON.stringify({ name: cleanName, public: false, description: "Gemaakt met BPM Playlist Maker" }),
  });
  for (let i = 0; i < unique.length; i += 100) {
    await spotifyFetch(token, `/playlists/${encodeURIComponent(playlist.id)}/items`, {
      method: "POST",
      body: JSON.stringify({ uris: unique.slice(i, i + 100) }),
    });
  }
  const url = playlist.external_urls && playlist.external_urls.spotify;
  return { url: typeof url === "string" ? url : "", count: unique.length };
}
