# BPM Playlist Maker

Maak een Spotify-playlist op basis van **BPM**, **genre** en **uitgavejaar** (bereik met twee schuiven). Bewerk en sorteer de lijst, voeg zelf nummers toe en exporteer met één klik naar Spotify (of als CSV).

## Hoe het werkt (en waarom er geen logins zijn)

- **Geen accounts, geen wachtwoorden, geen database.** De site bewaart niets op een server. Je concept staat alleen in de eigen browser (localStorage).
- **Verbinden met Spotify** gebruikt OAuth met PKCE: de gebruiker logt in op de pagina van Spotify zelf. Deze site ziet nooit een wachtwoord en heeft **geen Spotify client secret** nodig. De toegangstoken (max. 1 uur) staat alleen in `sessionStorage` van de browsertab en verdwijnt bij sluiten of via "Verbinding verbreken".
- **Zoeken en exporteren** gebeuren rechtstreeks vanuit de browser met die eigen token (Spotify laat zoeken zonder gebruiker niet meer betrouwbaar toe voor nieuwe apps).
- **Het enige geheim is de Last.fm-key**, in één kleine server-functie (`functions/api/[[route]].js`). Die functie doet ook de tempo-opvraging bij ReccoBeats (cache per nummer).

### De zoekflow

Er is geen gratis dienst die zomaar "geef me alle nummers van 120 BPM in genre X" beantwoordt. Daarom werkt de site in vier stappen, in rondes van 20 nummers zodat de eerste resultaten snel verschijnen:

1. **Kandidaten** uit Last.fm: de populairste nummers van het gekozen genre (tag, tot 10 pagina's).
2. **Spotify-zoeken** (met de token van de gebruiker): het echte nummer vinden (titel + artiest moeten overeenkomen).
3. **Tempo** opvragen bij [ReccoBeats](https://reccobeats.com) (geen API-key nodig), per Spotify-ID.
4. **Filteren** op de gekozen BPM ± marge.

**Periode** = het jaar uit de releasedatum van het album op Spotify. Dat is het jaar van de uitgave waarop Spotify het nummer vindt; bij heruitgaves of compilaties kan dat later zijn dan het originele jaar. Het jaarfilter gebeurt vóór de tempo-opvraging, dus een smal bereik kost vooral zoektijd.

## Belangrijke beperkingen

1. **Spotify development mode**: sinds februari 2026 vereist dit een actief Premium-abonnement voor de app-eigenaar en werkt de app (zoeken én export) voor **maximaal 5 gebruikers** die je handmatig toevoegt onder *User Management* in het Developer Dashboard. Zonder Premium bij de eigenaar geeft Spotify een 403; de site toont dan een uitleg. Voor onbeperkt publiek vraagt Spotify "extended quota" (in de praktijk een organisatie met ~250.000 maandelijkse gebruikers).
2. **Zoeken is trager en beperkter** dan met een BPM-database: de site moet per kandidaat een Spotify-zoekopdracht doen. Er zijn hooguit zo'n 250 kandidaten per genre (10 pagina's Last.fm), dus bij strenge combinaties (smalle marge + smal jaarbereik) kunnen er weinig resultaten zijn. Resultaten van eerdere zoekopdrachten worden in de proxy gecachet (tempo 7 dagen, Spotify-zoekopdrachten 6 uur, Last.fm 1 dag).
3. **ReccoBeats**: gratis, zonder key, maar met niet-gepubliceerde limieten en onduidelijke gebruiksvoorwaarden. Reageert de dienst niet (429/fout), dan meldt de site dat een deel niet gecontroleerd kon worden. Tempo's zijn schattingen; sommige nummers hebben dubbel of half tempo (bv. 60 i.p.v. 120).
4. **Niet getest tegen de echte Last.fm- en Spotify-API's** (alleen de tempo-aanroep en de Last.fm-route zijn live gecontroleerd). De ReccoBeats-aanroep is wel met een echt verzoek gecontroleerd. De rest is getest met nagebootste antwoorden (unit-tests + echte browsertest).

## Installatie (Cloudflare Pages, gratis)

1. **Spotify**: maak een app op https://developer.spotify.com/dashboard.
   - Redirect URI: `https://<jouw-project>.pages.dev/` (en voor lokaal testen `http://127.0.0.1:8788/`, niet `localhost`).
   - Voeg onder *User Management* de e-mailadressen toe van wie mag exporteren (max. 5).
   - Zet het **Client ID** in `public/js/config.js` (publiek, geen geheim).
2. **Last.fm-key**: https://www.last.fm/api/account/create
3. **Cloudflare Pages** koppelen aan deze GitHub-repository (Framework preset: None, build command leeg, output directory `public`).
4. Zet onder *Settings → Variables and secrets* (type *Secret*, omgeving *Production*) de variabele `LASTFM_KEY` en publiceer daarna opnieuw (Deployments → Retry deployment). Een Spotify client secret is niet nodig.
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
python3 test/e2e.py           # browsertest: verbinden, zoeken (ook 403), sorteren, slepen, handmatig toevoegen
python3 test/e2e-export.py    # browsertest: Spotify-redirect (PKCE), verbonden worden en export (gemockt)
```
(De browsertests gebruiken Playwright en Chrome.)
