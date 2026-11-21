"""Gedeelde nabootsing van de Spotify-API voor de browsertests."""
import json
import re
from urllib.parse import urlparse, parse_qs

CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type"}


YEARS = {"Belgian Banger": "1985-06-01", "Intl Pop": "1995", "Slow Song": "2001-01-01", "<img src=x onerror=alert1>": "2010-10-10", "Pop Hit": "1975-04-04"}


def id_for(title: str) -> str:
    return ("".join(f"{b:02x}" for b in title.encode()) + "x" * 22)[:22]


def install(page, mode="ok", log=None):
    """mode: 'ok' of 'forbidden' (search geeft 403)."""
    log = log if log is not None else []

    def search(route):
        req = route.request
        log.append((req.method, req.url))
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        if mode == "forbidden":
            return route.fulfill(status=403, headers=CORS, content_type="application/json", body='{"error":{"status":403}}')
        assert req.headers["authorization"] == "Bearer TESTTOKEN", req.headers
        q = parse_qs(urlparse(req.url).query)["q"][0]
        m = re.match(r"track:(.*) artist:(.*)$", q)
        name, artist = (m.group(1), m.group(2)) if m else (q, "Manual Artist")
        if name == "Unknown Track":
            items = []
        else:
            items = [{"uri": "spotify:track:" + id_for(name), "name": name, "artists": [{"name": artist}],
                      "album": {"name": "Album", "release_date": YEARS.get(name, "2020-01-01"), "images": []}, "duration_ms": 200000}]
        route.fulfill(status=200, headers=CORS, content_type="application/json", body=json.dumps({"tracks": {"items": items}}))

    page.route("https://api.spotify.com/v1/search**", search)
    return log


TOKEN_SCRIPT = "sessionStorage.setItem('spotify_token', JSON.stringify({value:'TESTTOKEN', expires: Date.now()+3600000}))"
