import sys
import time
import unicodedata

from playwright.sync_api import sync_playwright

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import spotify_mock

errors, csp = [], []


def wait_until(fn, timeout=10):
    # Polling in Python: Playwrights wait_for_function zou eval gebruiken, en dat verbiedt onze CSP.
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return
        time.sleep(0.1)
    raise AssertionError("timeout")


def titles(pg, sel):
    loc = pg.locator(sel + " .row strong")
    return [loc.nth(i).inner_text() for i in range(loc.count())]


def search(pg, genre="pop", y_from="1950", y_to="2026", bpm="120", tol="2"):
    pg.evaluate("document.getElementById('filters').open = true")
    b, t_ = int(bpm), int(tol)
    pg.evaluate("([a, c]) => { const lo = document.getElementById('bpm-lo'), hi = document.getElementById('bpm-hi'); lo.value = 40; hi.value = 220; lo.value = a; hi.value = c; lo.dispatchEvent(new Event('input')); hi.dispatchEvent(new Event('input')); }", [b - t_, b + t_])
    pg.fill("#genre", genre)
    pg.fill("#year-from", y_from)
    pg.fill("#year-to", y_to if y_to != "2026" else pg.get_attribute("#year-to", "max"))
    pg.click("#search-btn")
    wait_until(lambda: pg.inner_text("#status") not in ("", "Zoeken…") and pg.is_enabled("#search-btn"))
    return titles(pg, "#results")


def watch(pg):
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: (csp.append(m.text) if "Content Security" in m.text else None))
    pg.on("dialog", lambda d: d.dismiss())


def rows(pg):
    out = []
    loc = pg.locator("#results .row")
    for i in range(loc.count()):
        r = loc.nth(i)
        meta = r.locator(".meta span").inner_text()
        year = int(meta.rsplit("·", 1)[1]) if "·" in meta else None
        out.append((r.locator("strong").inner_text(), int(r.locator(".bpm").inner_text()), year))
    return out


with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])

    # A. zonder Spotify-verbinding kan je gewoon zoeken
    pg = b.new_context(locale="nl-BE").new_page()
    watch(pg)
    pg.goto("http://127.0.0.1:8799/")
    assert pg.inner_text("#connect-state") == "Niet verbonden met Spotify"
    assert pg.is_visible("#connect-btn") and not pg.is_visible("#disconnect-btn")
    assert pg.input_value("#year-from") == "1950" and pg.input_value("#year-to") == pg.get_attribute("#year-to", "max")
    res = search(pg)
    print("status:", pg.inner_text("#status"))
    assert res, "resultaten zonder verbinding"
    # export zonder verbinding: duidelijke melding
    pg.click("#add-top")
    pg.click("#export-btn")
    assert "Verbind eerst met Spotify" in pg.inner_text("#export-result")
    pg.close()

    # B. verbonden: volledige flow
    pg = b.new_context(locale="nl-BE").new_page()
    watch(pg)
    pg.add_init_script(spotify_mock.TOKEN_SCRIPT)
    spotify_mock.install(pg)
    pg.goto("http://127.0.0.1:8799/")
    assert pg.inner_text("#connect-state") == "Verbonden met Spotify"

    # jaarschuiven: "van" duwt "tot" mee en omgekeerd
    pg.evaluate("document.getElementById('filters').open = true")
    pg.fill("#year-from", "2000"); pg.fill("#year-to", "1990")
    assert pg.input_value("#year-from") == "1990" and pg.input_value("#year-to") == "1990"
    pg.fill("#year-from", "1950"); pg.fill("#year-to", pg.get_attribute("#year-to", "max"))

    # tempo + marge
    search(pg, genre="pop", tol="2")
    r = rows(pg)
    print("pop 120±2:", len(r), r[:3])
    assert r and all(118 <= bpm <= 122 for _, bpm, _ in r)
    first_total = int(pg.inner_text("#status").split()[0])

    # jaarbereik
    search(pg, genre="pop", tol="2", y_from="1980", y_to="1989")
    r = rows(pg)
    print("pop 1980-1989:", len(r))
    assert r and all(1980 <= y <= 1989 for _, _, y in r), r
    assert int(pg.inner_text("#status").split()[0]) < first_total

    # exact en genre-filter
    search(pg, genre="hip hop", tol="0")
    r = rows(pg)
    assert r and all(bpm == 120 for _, bpm, _ in r), r

    # onbekend genre: duidelijke melding; leeg genre: alles
    search(pg, genre="zzzz")
    assert "Geen genre gevonden" in pg.inner_text("#status") and rows(pg) == []
    search(pg, genre="")
    assert rows(pg), "leeg genre = alle genres"

    # operators: "a, b" = of, "-x" sluit uit
    both = len(search(pg, genre="pop, rock", tol="5") and rows(pg)) and int(pg.inner_text("#status").split()[0])
    pop_n = (search(pg, genre="pop", tol="5"), int(pg.inner_text("#status").split()[0]))[1]
    assert both >= pop_n, (both, pop_n)
    no_rap = (search(pg, genre="hip hop -rap", tol="5"), pg.inner_text("#status"))[1]
    assert ("0 nummers" in no_rap) or int(no_rap.split()[0]) >= 0
    only_rap = (search(pg, genre="hip hop", tol="5"), int(pg.inner_text("#status").split()[0]))[1]
    excl = search(pg, genre="hip hop -rap", tol="5") and int(pg.inner_text("#status").split()[0])
    assert excl < only_rap, (excl, only_rap)

    # taal wisselen: meteen, zonder pagina te herladen
    pg.evaluate("window.__alive = 1")
    pg.click('[data-lang="en"]')
    assert pg.inner_text("h1") == "Run to the beat."
    assert "tracks found" in pg.inner_text("#status"), pg.inner_text("#status")
    assert pg.evaluate("window.__alive") == 1 and pg.evaluate("document.documentElement.lang") == "en"
    pg.click('[data-lang="fr"]')
    assert pg.inner_text("h1") == "Cours au rythme."
    pg.click('[data-lang="nl"]')
    assert pg.inner_text("h1") == "Loop op het ritme."
    assert "nummers gevonden" in pg.inner_text("#status")

    # meer tonen
    search(pg, genre="", tol="5")
    n = len(rows(pg))
    total = int(pg.inner_text("#status").split()[0])
    assert n == 30 and total > 30, (n, total)
    pg.click("#more-btn")
    assert len(rows(pg)) == min(55, total)

    # playlist
    search(pg, genre="pop", tol="2")
    pg.click("#add-top")
    wait_until(lambda: pg.locator("#pl-list .row").count() == 25)
    print("summary:", pg.inner_text("#pl-summary"))
    assert "25 nummers" in pg.inner_text("#pl-summary")
    pg.select_option("#sort", "title")
    t = titles(pg, "#pl-list")
    ordered = pg.evaluate("""(t) => t.every((x, i) => i === 0 || t[i - 1].localeCompare(x, undefined, { sensitivity: 'base', numeric: true }) <= 0)""", t)
    assert ordered, t[:5]
    pg.locator("#pl-list .row").nth(0).get_by_role("button", name="omlaag").click()
    assert titles(pg, "#pl-list")[1] == t[0]
    pg.locator("#pl-list .row").nth(2).drag_to(pg.locator("#pl-list .row").nth(0))
    assert pg.locator("#results button:disabled").count() >= 25

    pg.fill("#manual-q", "Eigen Nummer")
    pg.click("#manual-form button")
    pg.wait_for_selector("#manual-results .row")
    pg.click("#manual-results .row button")
    assert pg.locator("#pl-list .row").count() == 26

    pg.reload()
    pg.wait_for_selector("#pl-list .row")
    assert pg.locator("#pl-list .row").count() == 26, "draft hersteld"
    assert "spotify_token" not in pg.evaluate("JSON.stringify(localStorage)"), "token niet in localStorage"

    # C. verbinding verbreken
    pg.click("#disconnect-btn")
    assert pg.inner_text("#connect-state") == "Niet verbonden met Spotify"
    assert pg.evaluate("sessionStorage.getItem('spotify_token')") is None
    b.close()
print("page errors:", errors)
print("csp:", csp)
sys.exit(1 if errors or csp else 0)
