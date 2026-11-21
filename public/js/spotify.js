// Spotify-koppeling zonder eigen login en zonder client secret in de browser.
// OAuth Authorization Code + PKCE: de gebruiker logt in op de pagina van Spotify zelf.
// Deze site ziet nooit een wachtwoord en bewaart geen token (alleen in het geheugen, enkele seconden).

const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";
const SCOPES = "playlist-modify-private playlist-modify-public";
const VERIFIER_KEY = "pkce_verifier";
const STATE_KEY = "pkce_state";
const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;

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

/** Verwerkt de terugkeer van Spotify. Geeft een access token terug, of gooit een fout. */
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
  return data.access_token;
}

async function spotify(token, path, body) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 403) {
    throw new Error(
      "Spotify weigert toegang (403). Staat dit Spotify-account bij 'User Management' in het Spotify Developer Dashboard? " +
        "Apps in development mode werken maar voor maximaal 5 toegevoegde gebruikers.",
    );
  }
  if (res.status === 429) throw new Error("Spotify vraagt om even te wachten (te veel aanvragen). Probeer het zo opnieuw.");
  if (!res.ok) throw new Error(`Spotify-fout ${res.status} bij ${path.split("/")[1] || path}.`);
  return res.json();
}

/** Maakt de (private) playlist aan en voegt de nummers toe in blokken van 100. */
export async function exportPlaylist(token, { name, uris }) {
  const cleanName = String(name || "Mijn BPM-playlist").slice(0, 100);
  const unique = [...new Set(uris)].filter((u) => TRACK_URI.test(u));
  if (!unique.length) throw new Error("Er zijn geen geldige nummers om te exporteren.");

  const playlist = await spotify(token, "/me/playlists", {
    name: cleanName,
    public: false,
    description: "Gemaakt met BPM Playlist Maker",
  });
  for (let i = 0; i < unique.length; i += 100) {
    await spotify(token, `/playlists/${encodeURIComponent(playlist.id)}/items`, { uris: unique.slice(i, i + 100) });
  }
  const url = playlist.external_urls && playlist.external_urls.spotify;
  return { url: typeof url === "string" ? url : "", count: unique.length };
}
