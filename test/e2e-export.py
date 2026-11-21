from playwright.sync_api import sync_playwright
from urllib.parse import urlparse, parse_qs
import sys
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    pg = b.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.route("**/js/config.js", lambda r: r.fulfill(content_type="text/javascript", body='export const CONFIG={SPOTIFY_CLIENT_ID:"testclientid123"};'))
    seen = []
    def spotify(route):
        req = route.request
        seen.append((req.method, req.url))
        if "api/token" in req.url:
            assert "code_verifier=" in req.post_data and "client_secret" not in req.post_data
            route.fulfill(content_type="application/json", headers={"access-control-allow-origin": "*"}, body='{"access_token":"USERTOKEN"}')
        elif req.url.endswith("/me/playlists"):
            assert req.headers["authorization"] == "Bearer USERTOKEN"
            route.fulfill(content_type="application/json", headers={"access-control-allow-origin": "*"}, body='{"id":"PL1","external_urls":{"spotify":"https://open.spotify.com/playlist/PL1"}}')
        elif "/playlists/PL1/items" in req.url:
            route.fulfill(content_type="application/json", headers={"access-control-allow-origin": "*"}, body='{"snapshot_id":"x"}')
        else:
            route.abort()
    pg.route("https://api.spotify.com/**", spotify)
    pg.route("https://accounts.spotify.com/api/token", spotify)
    auth = {}
    def authorize(route):
        auth["url"] = route.request.url
        route.abort()
    pg.route("https://accounts.spotify.com/authorize**", authorize)
    pg.goto("http://127.0.0.1:8799/")
    pg.fill("#manual-q", "Eigen Nummer"); pg.click("#manual-form button")
    pg.wait_for_selector("#manual-results .row"); pg.click("#manual-results .row button")
    pg.click("#export-btn"); pg.wait_for_timeout(800)
    q = parse_qs(urlparse(auth["url"]).query)
    print({k: v[0] for k, v in q.items() if k != "code_challenge"})
    assert q["code_challenge_method"] == ["S256"] and "client_secret" not in q and q["response_type"] == ["code"]
    state = q["state"][0]
    # simuleer terugkeer van Spotify (state moet in sessionStorage staan -> zelfde context)
    pg.goto("http://127.0.0.1:8799/?code=abc&state=" + state)
    pg.wait_for_selector("#export-result .msg.ok", timeout=5000)
    print("export:", pg.inner_text("#export-result"), "| link:", pg.locator("#export-result a").get_attribute("href"))
    print("url after:", pg.url)
    assert pg.url == "http://127.0.0.1:8799/"
    # verkeerde state wordt geweigerd
    pg.evaluate("sessionStorage.setItem('pkce_state','good'); sessionStorage.setItem('pkce_verifier','v')")
    pg.goto("http://127.0.0.1:8799/?code=abc&state=evil")
    pg.wait_for_selector("#export-result .msg.error")
    print("bad state:", pg.inner_text("#export-result"))
    print("token left in storage:", pg.evaluate("JSON.stringify([localStorage, sessionStorage]).includes('USERTOKEN')"))
    print("errors:", errs)
    b.close()
sys.exit(1 if errs else 0)
