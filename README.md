# BPM Playlist Maker

Maak een Spotify-playlist op basis van **BPM**, **genre** en **jouw land**. Bewerk en sorteer de lijst, voeg zelf nummers toe en exporteer met één klik naar Spotify (of als CSV).

## Hoe het werkt (en waarom er geen logins zijn)

- **Geen accounts, geen wachtwoorden, geen database.** De site bewaart niets op een server. Je concept staat alleen in de eigen browser (localStorage).
- **Export naar Spotify** gebruikt OAuth met PKCE: de gebruiker logt in op de pagina van Spotify zelf. Deze site ziet nooit een wachtwoord en bewaart geen token (het leeft enkele seconden in het geheugen).
- **Alle geheimen zitten in één kleine server-functie** (`functions/api/[[route]].js`): GetSongBPM-key, Last.fm-key en het Spotify client secret. De browser praat alleen met die functie, op hetzelfde domein.
- **BPM** komt van GetSongBPM (Spotify levert tempo niet meer aan nieuwe apps). **Locatie** = het land van de gebruiker (standaard geraden uit de browsertaal, aanpasbaar). Een nummer scoort hoger als de artiest uit dat land komt (GetSongBPM) of als het nummer/de artiest er populair is (Last.fm). Met het vinkje "alleen artiesten uit dit land of lokaal populair" filter je daarop.

## Belangrijke beperkingen

1. **Spotify development mode**: sinds februari 2026 vereist dit een Premium-account voor de app-eigenaar en werkt de export voor **maximaal 5 gebruikers** die je handmatig toevoegt onder *User Management* in het Developer Dashboard. Voor een publieke site met onbeperkt veel gebruikers vraagt Spotify "extended quota" (in de praktijk een organisatie met ~250.000 maandelijkse gebruikers). Daarom is er ook **Download als CSV** voor iedereen.
2. **GetSongBPM** geeft per BPM de meest bekeken nummers, niet de hele catalogus. Met strenge filters (genre + land) kan de lijst kort zijn: vergroot dan de marge of zet de landfilter uit. Een zichtbare link naar getsongbpm.com is **verplicht** (staat in de footer; haal die niet weg).
3. **Niet getest tegen de echte API's.** De code is geschreven volgens de officiële documentatie en getest met nagebootste antwoorden (unit-tests + echte browsertest). Wijkt een veldnaam van GetSongBPM af, dan hoef je alleen `normalizeTempoItem` in `public/js/logic.js` aan te passen.

## Installatie (Cloudflare Pages, gratis)

1. **Spotify**: maak een app op https://developer.spotify.com/dashboard.
   - Redirect URIs: `https://<jouw-project>.pages.dev/` en voor lokaal testen `http://127.0.0.1:8788/` (niet `localhost`).
   - Voeg onder *User Management* de e-mailadressen toe van wie mag exporteren (max. 5).
   - Zet het **Client ID** in `public/js/config.js` (publiek, geen geheim).
2. **Keys**: GetSongBPM (https://getsongbpm.com/api) en Last.fm (https://www.last.fm/api/account/create).
3. **Deploy**:
   ```bash
   npx wrangler pages deploy public --project-name bpm-playlist-maker
   npx wrangler pages secret put GETSONGBPM_KEY      --project-name bpm-playlist-maker
   npx wrangler pages secret put LASTFM_KEY          --project-name bpm-playlist-maker
   npx wrangler pages secret put SPOTIFY_CLIENT_ID   --project-name bpm-playlist-maker
   npx wrangler pages secret put SPOTIFY_CLIENT_SECRET --project-name bpm-playlist-maker
   ```
   Daarna nog één keer `deploy` uitvoeren zodat de secrets actief zijn.
4. **Lokaal**: kopieer `.dev.vars.example` naar `.dev.vars`, vul de keys in en draai `npx wrangler pages dev public` (poort 8788).

## Beveiliging in het kort

- Strikte Content-Security-Policy (`public/_headers`): alleen eigen scripts, verbindingen alleen naar eigen domein en Spotify.
- De UI bouwt alles met `textContent` (geen `innerHTML`): een nummertitel met HTML wordt als tekst getoond.
- De proxy valideert elke parameter, gebruikt de GetSongBPM-key als header (niet in de URL), cachet antwoorden (spaart je API-limieten) en weigert verzoeken van andere websites in de browser (`Sec-Fetch-Site`).
- CSV-export neutraliseert formule-injectie (`=`, `+`, `-`, `@`).
- Voeg in het Cloudflare-dashboard eventueel een **rate limiting rule** toe op `/api/*` als de site publiek wordt.

## Tests

```bash
npm test                      # 20 unit-tests (logica, PKCE-testvector, proxy)
node test/e2e-server.mjs &    # nagebootste server met de echte CSP
python3 test/e2e.py           # browsertest: zoeken, sorteren, slepen, handmatig toevoegen
python3 test/e2e-export.py    # browsertest: Spotify-redirect + export (gemockt)
```
(De browsertests gebruiken Playwright en Chrome.)
