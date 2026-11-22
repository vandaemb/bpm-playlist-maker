"""Spotify-aanmelding (PKCE) en export, met nagebootste Spotify-servers."""
import json
import sys
from urllib.parse import urlparse, parse_qs

from playwright.sync_api import sync_playwright

CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type"}
DRAFT = {"name": "Testlijst", "items": [{"key": "a|b", "title": "A", "artist": "B", "bpm": 120,
         "uri": "spotify:track:" + "a" * 22, "image": "", "durationMs": 1000}]}
errs, calls = [], []

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    pg = b.new_context(locale="nl-BE").new_page()
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.route("**/js/config.js", lambda r: r.fulfill(content_type="text/javascript", body='export const CONFIG={SPOTIFY_CLIENT_ID:"testclientid123"};'))
    pg.add_init_script("try { if(!localStorage.getItem('bpm-playlist-draft-v1')) localStorage.setItem('bpm-playlist-draft-v1', %s) } catch (e) {}" % json.dumps(json.dumps(DRAFT)))

    def api(route):
        req = route.request
        calls.append((req.method, req.url))
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        if "accounts.spotify.com/api/token" in req.url:
            assert "code_verifier=" in req.post_data and "client_secret" not in req.post_data
            return route.fulfill(content_type="application/json", headers=CORS, body='{"access_token":"USERTOKEN","expires_in":3600}')
        assert req.headers["authorization"] == "Bearer USERTOKEN"
        if req.url.endswith("/me/playlists"):
            body = json.loads(req.post_data)
            assert body["public"] is False and body["name"] == "Testlijst"
            return route.fulfill(content_type="application/json", headers=CORS, body='{"id":"PL1","external_urls":{"spotify":"https://open.spotify.com/playlist/PL1"}}')
        if "/playlists/PL1/items" in req.url:
            assert json.loads(req.post_data)["uris"] == ["spotify:track:" + "a" * 22]
            return route.fulfill(content_type="application/json", headers=CORS, body='{"snapshot_id":"x"}')
        route.abort()

    pg.route("https://api.spotify.com/**", api)
    pg.route("https://accounts.spotify.com/api/token", api)
    auth = {}
    pg.route("https://accounts.spotify.com/authorize**", lambda r: (auth.update(url=r.request.url), r.abort()))

    # 1. exporteren zonder verbinding: duidelijke melding
    pg.goto("http://127.0.0.1:8799/")
    pg.wait_for_selector("#pl-list .row")
    pg.click("#export-btn")
    assert "Verbind eerst met Spotify" in pg.inner_text("#export-result")

    # 2. verbinden: redirect naar Spotify met PKCE, zonder secret
    pg.click("#connect-btn")
    pg.wait_for_timeout(800)
    q = parse_qs(urlparse(auth["url"]).query)
    print({k: v[0] for k, v in q.items() if k != "code_challenge"})
    assert q["code_challenge_method"] == ["S256"] and q["response_type"] == ["code"] and "client_secret" not in q
    assert q["scope"] == ["playlist-modify-private playlist-modify-public"]
    state = q["state"][0]

    # 3. terugkeer van Spotify: verbonden, URL opgeschoond
    pg.goto("http://127.0.0.1:8799/?code=abc&state=" + state)
    for _ in range(50):
        if pg.inner_text("#connect-state") == "Verbonden met Spotify":
            break
        pg.wait_for_timeout(100)
    assert pg.inner_text("#connect-state") == "Verbonden met Spotify"
    assert pg.url == "http://127.0.0.1:8799/", pg.url
    assert "USERTOKEN" not in pg.evaluate("JSON.stringify(localStorage)")

    # 4. exporteren met één klik
    pg.click("#export-btn")
    pg.wait_for_selector("#export-result .msg.ok", timeout=5000)
    print("export:", pg.inner_text("#export-result"), "| link:", pg.locator("#export-result a").get_attribute("href"))
    assert pg.locator("#export-result a").get_attribute("href") == "https://open.spotify.com/playlist/PL1"

    # 5. verkeerde state wordt geweigerd
    pg.evaluate("sessionStorage.clear(); sessionStorage.setItem('pkce_state','good'); sessionStorage.setItem('pkce_verifier','v')")
    pg.goto("http://127.0.0.1:8799/?code=abc&state=evil")
    for _ in range(50):
        if "bevestigd" in pg.inner_text("#status"):
            break
        pg.wait_for_timeout(100)
    print("bad state:", pg.inner_text("#status"))
    assert "kon niet worden bevestigd" in pg.inner_text("#status")
    assert pg.inner_text("#connect-state") == "Niet verbonden met Spotify"
    print("errors:", errs)
    b.close()
sys.exit(1 if errs else 0)
