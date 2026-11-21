import sys
import time

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


def search(pg, genre="", abroad=False, bpm="120", tol="2"):
    pg.fill("#bpm", bpm)
    pg.select_option("#tol", tol)
    pg.fill("#genre", genre)
    pg.select_option("#country", "BE")
    pg.set_checked("#abroad", abroad)
    pg.click("#search-btn")
    wait_until(lambda: ("gevonden" in pg.inner_text("#status") or "mislukt" in pg.inner_text("#status")) and pg.is_enabled("#search-btn"))
    return titles(pg, "#results")


def watch(pg):
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: (csp.append(m.text) if "Content Security" in m.text else None))
    pg.on("dialog", lambda d: d.dismiss())


with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])

    # A. niet verbonden: duidelijke melding, geen zoekopdracht
    pg = b.new_page()
    watch(pg)
    pg.goto("http://127.0.0.1:8799/")
    assert pg.inner_text("#connect-state") == "Niet verbonden met Spotify"
    assert pg.is_visible("#connect-btn") and not pg.is_visible("#disconnect-btn")
    pg.click("#search-btn")
    assert "Verbind eerst met Spotify" in pg.inner_text("#status")
    pg.close()

    # B. 403 van Spotify: zoekopdracht stopt met uitleg (geen stille "0 gevonden")
    pg = b.new_page()
    watch(pg)
    pg.add_init_script(spotify_mock.TOKEN_SCRIPT)
    spotify_mock.install(pg, mode="forbidden")
    pg.goto("http://127.0.0.1:8799/")
    assert pg.inner_text("#connect-state") == "Verbonden met Spotify"
    res = search(pg)
    status = pg.inner_text("#status")
    print("403 status:", status[:120])
    assert res == [] and "403" in status and "Premium" in status
    pg.close()

    # C. verbonden: volledige flow
    pg = b.new_page()
    watch(pg)
    pg.add_init_script(spotify_mock.TOKEN_SCRIPT)
    spotify_mock.install(pg)
    pg.goto("http://127.0.0.1:8799/")
    assert pg.locator("#country option").count() > 20

    res = search(pg)
    print("local:", res)
    assert sorted(res) == sorted(["Belgian Banger", "Intl Pop", "<img src=x onerror=alert1>"]), res
    assert pg.locator("#results img").count() == 0  # HTML-titel wordt als tekst getoond
    assert "populair in België" in pg.locator("#results .row").first.inner_text()

    res = search(pg, tol="0")
    print("exact:", res)
    assert res == ["Belgian Banger"], res

    res = search(pg, genre="pop")
    print("pop local:", res)
    assert res == ["Intl Pop"], res

    res = search(pg, genre="pop", abroad=True)
    print("pop abroad:", res)
    assert sorted(res) == ["Intl Pop", "Pop Hit"], res

    search(pg)
    pg.click("#add-top")
    wait_until(lambda: pg.locator("#pl-list .row").count() == 3)
    print("summary:", pg.inner_text("#pl-summary"))
    pg.select_option("#sort", "title")
    t = titles(pg, "#pl-list")
    assert t == sorted(t, key=str.lower), t
    pg.locator("#pl-list .row").nth(0).get_by_role("button", name="omlaag").click()
    assert titles(pg, "#pl-list")[1] == t[0]
    pg.locator("#pl-list .row").nth(2).drag_to(pg.locator("#pl-list .row").nth(0))
    print("after drag:", titles(pg, "#pl-list"))
    assert pg.locator("#results button:disabled").count() == 3

    pg.fill("#manual-q", "Eigen Nummer")
    pg.click("#manual-form button")
    pg.wait_for_selector("#manual-results .row")
    pg.click("#manual-results .row button")
    assert pg.locator("#pl-list .row").count() == 4

    pg.reload()
    pg.wait_for_selector("#pl-list .row")
    assert pg.locator("#pl-list .row").count() == 4, "draft hersteld"
    assert "spotify_token" not in pg.evaluate("JSON.stringify(localStorage)"), "token niet in localStorage"

    # D. verbinding verbreken
    pg.click("#disconnect-btn")
    assert pg.inner_text("#connect-state") == "Niet verbonden met Spotify"
    assert pg.evaluate("sessionStorage.getItem('spotify_token')") is None
    b.close()
print("page errors:", errors)
print("csp:", csp)
sys.exit(1 if errors or csp else 0)
