from playwright.sync_api import sync_playwright
import sys
errors, csp = [], []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    pg = b.new_page()
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: (csp.append(m.text) if "Content Security" in m.text else None) or (errors.append(m.text) if m.type == "error" else None))
    dialogs = []
    pg.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
    pg.goto("http://127.0.0.1:8799/")
    assert pg.locator("#country option").count() > 20
    pg.fill("#bpm", "120"); pg.fill("#genre", "pop"); pg.select_option("#country", "BE")
    pg.click("#search-btn")
    pg.wait_for_selector("#results .row")
    rows = pg.locator("#results .row")
    texts = [rows.nth(i).inner_text() for i in range(rows.count())]
    print("results:", [t.replace("\n", " | ") for t in texts])
    assert rows.count() == 3, rows.count()                       # metal eruit gefilterd
    assert "uit België" in texts[0] or "België" in texts[0]
    assert pg.locator("#results img").count() == 0              # titel met HTML wordt als tekst getoond
    assert pg.evaluate("window.__xss === undefined")
    pg.check("#strict"); pg.click("#search-btn"); pg.wait_for_timeout(400)
    print("strict count:", pg.locator("#results .row").count())
    pg.uncheck("#strict"); pg.click("#search-btn"); pg.wait_for_timeout(400)
    pg.click("#add-top")
    pg.wait_for_function("document.querySelectorAll('#pl-list .row').length === 3")
    pg.wait_for_function("!document.querySelector('#pl-summary').textContent.includes('nog te zoeken')")
    print("summary:", pg.inner_text("#pl-summary"))
    # sorteren
    pg.select_option("#sort", "title")
    titles = [pg.locator("#pl-list .row strong").nth(i).inner_text() for i in range(3)]
    print("sorted:", titles); assert titles == sorted(titles, key=str.lower)
    # omlaag-knop
    pg.locator("#pl-list .row").nth(0).get_by_role("button", name="omlaag").click()
    assert pg.locator("#pl-list .row strong").nth(1).inner_text() == titles[0]
    # drag & drop
    pg.locator("#pl-list .row").nth(2).drag_to(pg.locator("#pl-list .row").nth(0))
    print("after drag:", [pg.locator("#pl-list .row strong").nth(i).inner_text() for i in range(3)])
    # handmatig toevoegen
    pg.fill("#manual-q", "Eigen Nummer"); pg.click("#manual-form button")
    pg.wait_for_selector("#manual-results .row")
    pg.click("#manual-results .row button")
    assert pg.locator("#pl-list .row").count() == 4
    # persistentie
    pg.reload(); pg.wait_for_selector("#pl-list .row")
    assert pg.locator("#pl-list .row").count() == 4, "draft hersteld"
    # export zonder client id -> duidelijke melding
    pg.click("#export-btn")
    print("export msg:", pg.inner_text("#export-result"))
    # export met client id -> redirect naar Spotify met PKCE
    pg.evaluate("sessionStorage.clear()")
    b.close()
print("page errors:", errors); print("csp:", csp)
sys.exit(1 if errors or csp else 0)
