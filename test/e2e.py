from playwright.sync_api import sync_playwright
import sys

errors, csp = [], []


import time


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
    wait_until(lambda: "gevonden" in pg.inner_text("#status") and pg.is_enabled("#search-btn"))
    return titles(pg, "#results")


with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    pg = b.new_page()
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: (csp.append(m.text) if "Content Security" in m.text else None) or (errors.append(m.text) if m.type == "error" else None))
    pg.on("dialog", lambda d: d.dismiss())
    pg.goto("http://127.0.0.1:8799/")
    assert pg.locator("#country option").count() > 20

    # 1. zonder genre: landtop gefilterd op tempo 120 +- 2 (Slow Song valt af)
    res = search(pg)
    print("local:", res)
    assert sorted(res) == sorted(["Belgian Banger", "Intl Pop", "<img src=x onerror=alert(1)>"]), res
    assert pg.locator("#results img").count() == 0  # HTML-titel wordt als tekst getoond
    assert "populair in België" in pg.locator("#results .row").first.inner_text()

    # 2. exacte marge: alleen 120
    res = search(pg, tol="0")
    print("exact:", res)
    assert res == ["Belgian Banger"], res

    # 3. genre pop, zonder buitenland: enkel lokaal populaire (Intl Pop); Pop Hit is niet lokaal
    res = search(pg, genre="pop")
    print("pop local:", res)
    assert res == ["Intl Pop"], res

    # 4. genre pop met buitenland: ook Pop Hit
    res = search(pg, genre="pop", abroad=True)
    print("pop abroad:", res)
    assert sorted(res) == ["Intl Pop", "Pop Hit"], res

    # 5. toevoegen, sorteren, verplaatsen, slepen
    res = search(pg)
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
    assert pg.locator("#results button:disabled").count() == 3  # reeds toegevoegd

    # 6. handmatig toevoegen
    pg.fill("#manual-q", "Eigen Nummer")
    pg.click("#manual-form button")
    pg.wait_for_selector("#manual-results .row")
    pg.click("#manual-results .row button")
    assert pg.locator("#pl-list .row").count() == 4

    # 7. persistentie
    pg.reload()
    pg.wait_for_selector("#pl-list .row")
    assert pg.locator("#pl-list .row").count() == 4, "draft hersteld"

    # 8. export zonder client id -> duidelijke melding (config.js bevat het echte ID? dan redirect)
    b.close()
print("page errors:", errors)
print("csp:", csp)
sys.exit(1 if errors or csp else 0)
