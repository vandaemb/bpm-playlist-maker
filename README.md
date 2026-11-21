# BPM Playlist Maker

Maak een Spotify-playlist op basis van **BPM**, **genre** en **jouw land**. Bewerk en sorteer de lijst, voeg zelf nummers toe en exporteer met één klik naar Spotify (of als CSV).

## Hoe het werkt (en waarom er geen logins zijn)

- **Geen accounts, geen wachtwoorden, geen database.** De site bewaart niets op een server. Je concept staat alleen in de eigen browser (localStorage).
- **Export naar Spotify** gebruikt OAuth met PKCE: de gebruiker logt in op de pagina van Spotify zelf. Deze site ziet nooit een wachtwoord en bewaart geen token (het leeft enkele seconden in het geheugen).
- **Geheimen zitten in één kleine server-functie** (`functions/api/[[route]].js`): de Last.fm-key en het Spotify client secret. De browser praat alleen met die functie, op hetzelfde domein.

### De zoekflow

Er is geen gratis dienst die zomaar "geef me alle nummers van 120 BPM in genre X" beantwoordt. Daarom werkt de site in vier stappen, in rondes van 20 nummers zodat de eerste resultaten snel verschijnen:

1. **Kandidaten** uit Last.fm: de populairste nummers van het gekozen land, en/of van het gekozen genre (tag).
2. **Spotify-zoeken**: het echte nummer vinden (titel + artiest moeten overeenkomen).
3. **Tempo** opvragen bij [ReccoBeats](https://reccobeats.com) (geen API-key nodig), per Spotify-ID.
4. **Filteren** op de gekozen BPM ± marge.

**Locatie** = het land van de gebruiker (standaard geraden uit de browsertaal, aanpasbaar). Zonder genre zijn de kandidaten de top van dat land. Met genre blijven alleen nummers over die in dat genre én (het nummer of de artiest) in dat land populair zijn, tenzij je "ook nummers tonen die niet in mijn land populair zijn" aanvinkt.

## Belangrijke beperkingen

1. **Spotify development mode**: sinds februari 2026 vereist dit een Premium-account voor de app-eigenaar en werkt de export voor **maximaal 5 gebruikers** die je handmatig toevoegt onder *User Management* in het Developer Dashboard. Voor onbeperkt publiek vraagt Spotify "extended quota" (in de praktijk een organisatie met ~250.000 maandelijkse gebruikers). Daarom is er ook **Download als CSV** voor iedereen.
2. **Zoeken is trager en beperkter** dan met een BPM-database: de site moet per kandidaat een Spotify-zoekopdracht doen. Er zijn hooguit zo'n 250 kandidaten per land of genre (5 pagina's Last.fm), dus bij strenge combinaties (smalle marge + genre + land) kunnen er weinig resultaten zijn. Resultaten van eerdere zoekopdrachten worden in de proxy gecachet (tempo 7 dagen, Spotify-zoekopdrachten 6 uur, Last.fm 1 dag).
3. **ReccoBeats**: gratis, zonder key, maar met niet-gepubliceerde limieten en onduidelijke gebruiksvoorwaarden. Reageert de dienst niet (429/fout), dan meldt de site dat een deel niet gecontroleerd kon worden. Tempo's zijn schattingen; sommige nummers hebben dubbel of half tempo (bv. 60 i.p.v. 120).
4. **Niet getest tegen de echte Last.fm- en Spotify-API's.** De ReccoBeats-aanroep is wel met een echt verzoek gecontroleerd. De rest is getest met nagebootste antwoorden (unit-tests + echte browsertest).

## Installatie (Cloudflare Pages, gratis)

1. **Spotify**: maak een app op https://developer.spotify.com/dashboard.
   - Redirect URI: `https://<jouw-project>.pages.dev/` (en voor lokaal testen `http://127.0.0.1:8788/`, niet `localhost`).
   - Voeg onder *User Management* de e-mailadressen toe van wie mag exporteren (max. 5).
   - Zet het **Client ID** in `public/js/config.js` (publiek, geen geheim).
2. **Last.fm-key**: https://www.last.fm/api/account/create
3. **Cloudflare Pages** koppelen aan deze GitHub-repository (Framework preset: None, build command leeg, output directory `public`).
4. Zet onder *Settings → Variables and secrets* (type *Secret*) deze drie variabelen en publiceer daarna opnieuw (Deployments → Retry deployment):
   - `LASTFM_KEY`
   - `SPOTIFY_CLIENT_ID`
   - `SPOTIFY_CLIENT_SECRET`
5. **Lokaal**: kopieer `.dev.vars.example` naar `.dev.vars`, vul de keys in en draai `npx wrangler pages dev public` (poort 8788).

## Beveiliging in het kort

- Strikte Content-Security-Policy (`public/_headers`): alleen eigen scripts, verbindingen alleen naar eigen domein en Spotify.
- De UI bouwt alles met `textContent` (geen `innerHTML`): een nummertitel met HTML wordt als tekst getoond.
- De proxy valideert elke parameter, cachet antwoorden (spaart je API-limieten) en weigert verzoeken van andere websites in de browser (`Sec-Fetch-Site`).
- CSV-export neutraliseert formule-injectie (`=`, `+`, `-`, `@`).
- Voeg in het Cloudflare-dashboard eventueel een **rate limiting rule** toe op `/api/*` als de site publiek wordt.

## Tests

```bash
npm test                      # 21 unit-tests (logica, PKCE-testvector, proxy)
node test/e2e-server.mjs &    # nagebootste server met de echte CSP
python3 test/e2e.py           # browsertest: zoeken, sorteren, slepen, handmatig toevoegen
python3 test/e2e-export.py    # browsertest: Spotify-redirect + export (gemockt)
```
(De browsertests gebruiken Playwright en Chrome.)
