# BPM Playlist Maker

Maak een Spotify-playlist op basis van **BPM**, **genre** en **uitgavejaar** (bereik met twee schuiven). Bewerk en sorteer de lijst, voeg zelf nummers toe en exporteer met één klik naar Spotify (of als CSV).

## Hoe het werkt (en waarom er geen logins zijn)

- **Een volledig statische site.** Geen server-code, geen geheimen, geen database, geen accounts of wachtwoorden. Je concept staat alleen in de eigen browser (localStorage).
- **Zoeken is een filter in de browser** op een eigen nummerlijst (`public/data`, ± 77.000 nummers met titel, artiest, BPM, genre, uitgavejaar en Spotify-ID). Dat is snel en kent geen aanvraaglimieten.
- **Spotify is alleen nodig om te exporteren** (en om zelf een nummer te zoeken). Verbinden gebruikt OAuth met PKCE: de gebruiker logt in op de pagina van Spotify zelf; de site ziet nooit een wachtwoord en heeft geen client secret. De toegangstoken (max. 1 uur) staat alleen in `sessionStorage` van de tab. Voor de export zijn maar een paar aanvragen nodig, omdat de Spotify-ID's al in de lijst staan.

## De nummerlijst

De lijst is een bewerking van **[Almost a million Spotify tracks](https://zenodo.org/records/11453410)** (Zenodo, licentie **CC BY 4.0**, dus bronvermelding verplicht; die staat onderaan de site). We bewaren alleen nummers met titel, artiest, tempo (40–220), genre en uitgavejaar (≥ 1950), ontdubbeld per titel + artiest. De bronlijst heeft bij 89% van de nummers geen artiestnaam; die vallen dus af.

Opnieuw genereren (bv. met een andere bron):

```bash
python3 tools/build-data.py pad/naar/tracks.csv     # vereist pandas
```

Dit schrijft `public/data/bpm-<N>.json` (één bestand per blok van 10 BPM, zodat een zoekopdracht maar 1 à 3 kleine bestanden laadt), `genres.json` en `meta.json`.

**Let op:**
- **Tempo's zijn schattingen** van Spotify; sommige nummers hebben dubbel of half tempo (bv. 60 i.p.v. 120).
- **Jaar** is het jaar van het album waarop het nummer staat; bij heruitgaves of compilaties kan dat later zijn dan het origineel.
- De lijst is een **momentopname** (2024) en bevat dus geen nieuwere nummers.
- **Genre** is het genre van de artiest en op tags gebaseerd ("pop" vindt ook "dance pop"); leeg laten zoekt in alle genres.

## Installatie (Cloudflare Pages, gratis)

1. **Spotify**: maak een app op https://developer.spotify.com/dashboard (kies *Web API*).
   - Redirect URI: `https://<jouw-project>.pages.dev/` (en voor lokaal testen `http://127.0.0.1:8788/`, niet `localhost`).
   - Voeg onder *User Management* de e-mailadressen toe van wie mag exporteren (max. 5, development mode).
   - Zet het **Client ID** in `public/js/config.js` (publiek, geen geheim).
2. **Cloudflare Pages** koppelen aan deze GitHub-repository (Framework preset: None, build command leeg, output directory `public`). Variabelen of secrets zijn niet nodig.
3. **Lokaal**: `npx wrangler pages dev public` (poort 8788) of een willekeurige statische server op de map `public`.

## Beperkingen van Spotify (development mode)

Sinds februari 2026 vereist een app in development mode een actief Premium-abonnement bij de app-eigenaar en werkt de export voor **maximaal 5 gebruikers** die je handmatig toevoegt. Zonder Premium geeft Spotify een 403; de site toont dan een uitleg. Er is altijd **Download als CSV** als terugval.

## Beveiliging in het kort

- Strikte Content-Security-Policy (`public/_headers`): alleen eigen scripts, verbindingen alleen naar het eigen domein en Spotify.
- De UI bouwt alles met `textContent` (geen `innerHTML`): een nummertitel met HTML wordt als tekst getoond.
- CSV-export neutraliseert formule-injectie (`=`, `+`, `-`, `@`).
- Geen server-code en geen geheimen, dus niets om te hacken of te lekken.

## Tests

```bash
npm test                      # unit-tests (logica, filters, PKCE-testvector)
node test/e2e-server.mjs &    # statische testserver met de echte CSP en de echte nummerlijst
python3 test/e2e.py           # browsertest: zoeken op BPM/jaar/genre, sorteren, slepen, handmatig toevoegen
python3 test/e2e-export.py    # browsertest: Spotify-redirect (PKCE), verbonden worden en export (gemockt)
```
(De browsertests gebruiken Playwright en Chrome; Spotify wordt nagebootst.)


## Interface, talen en genre-operators

- **Stijl**: minimalistisch (Apple-achtig), gericht op joggen/sporten: groot BPM-bereik met één schuif met twee handvatten (de band = het tempobereik, dus de marge), snelkeuzes (wandelen, joggen, lopen, sprint, cooldown), genre en jaren altijd zichtbaar, FAQ onderaan. Logo: `public/logo.svg` (ook favicon).
- **Talen (NL/EN/FR/DE)**: alle teksten staan in `public/js/i18n.js`. Knoppen bovenaan wisselen meteen van taal, zonder pagina te herladen (keuze wordt onthouden). Een taal toevoegen = een blok in dat bestand + de taalcode in `LANGS` + een knop in `index.html`. `node test/run.mjs` controleert dat elke taal dezelfde sleutels heeft.
- **Genreveld**: `pop, rock` = pop of rock, `dance pop` = beide woorden in dezelfde tag, `pop -rap` (of `pop not rap`) = pop zonder rap. Staat uitgelegd in de FAQ.
- De dataset loopt tot en met 2024; dit staat bij de zoekknop, in de FAQ en hierboven.

## Tweede bron

`tools/build-data.py tracks.csv bsddataset.csv` voegt "Spotify Tracks Dataset" (maharshipandya, BSD) toe aan de Zenodo-lijst, ontdubbeld op Spotify-ID en titel+artiest. Die bron heeft geen jaartal; die nummers (jaar 0) verschijnen alleen als het jaarbereik volledig open staat. Samen: ~150.000 nummers.

## Geen Spotify-koppeling meer

De export naar Spotify, de Spotify-login en het zelf zoeken op Spotify zijn verwijderd (de Spotify-app in dev-modus laat maar 5 gebruikers toe). De playlist wordt gedownload als CSV met per nummer een Spotify-link. De site doet geen enkele externe aanvraag meer (CSP: `connect-src 'self'`). Het Spotify Client ID en de Spotify-app in het Dashboard zijn niet meer nodig. De FAQ legt uit hoe je de CSV in Spotify zet en dat diensten zoals TuneMyMusic of Soundiiz lijsten naar andere streamingdiensten kunnen overzetten. Boven de FAQ staat een korte animatie (alleen CSS) die de stappen toont.

## Alles in één keer naar Spotify

De knop "Kopieer Spotify-links" zet alle links onder elkaar op het klembord. Plakken (Ctrl+V / ⌘+V) in een lege afspeellijst in de Spotify-app op de computer voegt de nummers toe. Dit gedrag is niet door ons getest tegen de echte Spotify-app; de CSV blijft als terugval. De animatie boven de FAQ toont de zes stappen.
