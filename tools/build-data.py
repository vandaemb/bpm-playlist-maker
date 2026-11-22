#!/usr/bin/env python3
"""Bouwt de BPM-bestanden voor de site uit tracks.csv van
"Almost a million Spotify tracks" (Zenodo, CC BY 4.0): https://zenodo.org/records/11453410

Gebruik:  python3 tools/build-data.py pad/naar/tracks.csv

Schrijft naar public/data/:
  bpm-<N>.json   nummers met een tempo van N t/m N+9 (N = 40, 50, ...), [id, titel, artiest, bpm, jaar, populariteit, genres]
  genres.json    lijst met genre-namen (de getallen in "genres" verwijzen hiernaar)
  meta.json      aantallen en bronvermelding
We bewaren alleen nummers met titel, artiest, tempo (40-220), genre en jaar (>= 1950).
"""
import ast, json, os, re, sys, unicodedata
from collections import Counter

import pandas as pd

if len(sys.argv) != 2:
    sys.exit(__doc__)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "data")
os.makedirs(OUT, exist_ok=True)

cols = ["track_id", "name", "track_artists", "genres", "tempo", "album_release_date", "popularity"]
df = pd.read_csv(sys.argv[1], usecols=cols, low_memory=False)
df["year"] = pd.to_numeric(df.album_release_date.astype(str).str[:4], errors="coerce")
df = df.dropna(subset=["track_id", "name", "track_artists", "tempo", "genres", "year"])
df = df[(df.tempo >= 40) & (df.tempo < 220) & (df.year >= 1950) & (df.genres != "[]")]
df = df[df.track_id.astype(str).str.fullmatch(r"[A-Za-z0-9]{22}")]
df["popularity"] = df.popularity.fillna(0).astype(int)


def norm(s):
    s = unicodedata.normalize("NFD", str(s)).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


df["key"] = [norm(n) + "|" + norm(a) for n, a in zip(df.name, df.track_artists)]
df = df.sort_values("popularity", ascending=False).drop_duplicates("key")  # per titel+artiest het populairste

rows = []
counts = Counter()
for r in df.itertuples():
    try:
        tags = [t for t in ast.literal_eval(r.genres) if isinstance(t, str) and t]
    except Exception:
        continue
    if not tags:
        continue
    counts.update(tags)
    rows.append((r.track_id, r.name.strip(), str(r.track_artists).strip(), round(float(r.tempo), 1), int(r.year), r.popularity, tags))

names = [t for t, _ in counts.most_common()]
index = {t: i for i, t in enumerate(names)}
buckets = {}
for tid, name, artist, tempo, year, pop, tags in rows:
    b = int(tempo // 10) * 10
    buckets.setdefault(b, []).append([tid, name, artist, tempo, year, pop, sorted(index[t] for t in tags)])

for f in os.listdir(OUT):
    if f.endswith(".json"):
        os.remove(os.path.join(OUT, f))
for b, items in sorted(buckets.items()):
    items.sort(key=lambda x: -x[5])
    with open(os.path.join(OUT, f"bpm-{b}.json"), "w", encoding="utf-8") as fh:
        json.dump(items, fh, ensure_ascii=False, separators=(",", ":"))
with open(os.path.join(OUT, "genres.json"), "w", encoding="utf-8") as fh:
    json.dump(names, fh, ensure_ascii=False, separators=(",", ":"))
with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as fh:
    json.dump(
        {
            "tracks": len(rows),
            "genres": len(names),
            "top_genres": names[:60],
            "source": "Almost a million Spotify tracks (Zenodo, CC BY 4.0)",
            "source_url": "https://zenodo.org/records/11453410",
        },
        fh,
        ensure_ascii=False,
        indent=1,
    )
print(len(rows), "nummers,", len(names), "genres,", len(buckets), "bestanden")
