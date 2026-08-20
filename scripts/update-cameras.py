#!/usr/bin/env python3
"""Rebuild app/data/cameras.json from ristmikud.tallinn.ee.

Pipeline: fetch district pages -> parse camera ids/names -> geocode junctions
via OpenStreetMap Overpass (intersection nodes) and Maa-amet in-ADS (addresses),
with manual fallbacks for grade-separated or named spots.

Run:  python3 scripts/update-cameras.py
Overpass results are cached in .cache/ ; delete it to force a refetch.
"""
import html, json, os, re, sys, time, urllib.request, urllib.parse
from collections import defaultdict

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = os.path.join(REPO, ".cache")
os.makedirs(S, exist_ok=True)
OUT = os.path.join(REPO, "app", "data", "cameras.json")
BBOX = "59.30,24.45,59.58,25.05"  # covers Tallinn + Laagri + Viimsi edge

# ---------- fetch & parse the city's camera pages ----------
AREA_TAGS = ["HA", "KE", "KR", "LA", "MU", "NO", "P", "PI", "PT", "ST",
             "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
             "11", "12", "13", "14", "15", "19"]

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "tallinn-cam-locator/1.0 (personal project)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")

cam_names, cam_areas = {}, {}
for tag in AREA_TAGS:
    try:
        page = fetch(f"https://ristmikud.tallinn.ee/index.php/cams?area_tag={tag}")
    except Exception as e:
        print(f"area {tag} fetch failed: {e}", file=sys.stderr); continue
    for m in re.finditer(r"src='/last/(cam\d+)\.jpg'.*?<h1>([^<]{3,90})</h1>", page, re.S):
        cid, name = m.group(1), html.unescape(m.group(2)).strip()
        cam_names[cid] = name
        cam_areas.setdefault(cid, set()).add(tag)
    time.sleep(0.3)

cams = [{"id": c, "name": n, "areas": sorted(cam_areas[c])}
        for c, n in sorted(cam_names.items(), key=lambda x: int(x[0][3:]))]
print(f"parsed {len(cams)} cameras from ristmikud.tallinn.ee", file=sys.stderr)

# ---------- name parsing ----------
TYPO = {"Sõruse": "Sõpruse", "Kreutzwald": "Kreutzwaldi", "Baltijaam": "Balti jaam"}
SUFFIX = r"(?:tn|tänav|pst|puiestee|mnt|maantee|tee|väljak)"

def clean_name(n):
    n = n.replace("–", "-").replace(" ", " ")
    n = re.sub(r"\*+\s*$", "", n).strip()
    n = re.sub(r"\([^)]*\)", " ", n)          # drop all (...) qualifiers
    n = re.sub(r'["“”]', "", n)
    n = re.sub(r"\s+", " ", n).strip(" -").strip()
    return n

def split_streets(n):
    # sentinel-split: hyphen only splits after a street-type suffix or before space-dash-space
    t = re.sub(rf"\b({SUFFIX})\s*-\s*", r"\1|", n)
    t = t.replace(" - ", "|")
    parts = [p.strip() for p in t.split("|") if p.strip()]
    return parts

def stem(street):
    s = street.strip()
    s = re.sub(r"^\s*(?:[A-ZÕÄÖÜ]\.\s*)+", "", s)          # drop initials A. / J. / F. R.
    s = re.sub(r"\s+(ristmik|ringristmik|viadukt|tunnel|\d+)\s*$", "", s)  # junction qualifiers
    s = re.sub(rf"\s+{SUFFIX}\.?\s*$", "", s)               # drop trailing suffix word
    s = TYPO.get(s, s)
    return s.strip()

specs = {}   # camId -> dict(kind=..., data=...)
for c in cams:
    raw = c["name"]
    n = clean_name(raw)
    m = re.match(r"^(.*?P&R)\s*,\s*(.+)$", n)
    if m:
        specs[c["id"]] = {"kind": "addr", "addr": m.group(2).replace("mnt.", "mnt").strip()}
        continue
    parts = split_streets(n)
    if len(parts) >= 2:
        specs[c["id"]] = {"kind": "junction", "streets": [stem(p) for p in parts][:3]}
    else:
        specs[c["id"]] = {"kind": "special", "text": n}

# unique junctions & stems
junctions = {}
for cid, sp in specs.items():
    if sp["kind"] == "junction":
        key = tuple(sorted(sp["streets"]))
        junctions.setdefault(key, []).append(cid)
stems = sorted({s for key in junctions for s in key if s})
print(f"cams={len(cams)} junctions={len(junctions)} stems={len(stems)}", file=sys.stderr)

# ---------- Overpass: fetch all candidate ways in one query ----------
def word_re(st):
    st_esc = re.sub(r"([\\^$.|?*+()\[\]{}])", r"\\\1", st)
    if st in ("Türnpu", "Türnpuu"):
        return "(^| )Türnpuu?( |$)"
    return f"(^| ){st_esc}( |$)"

ENDPOINTS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
]

def overpass(query):
    last = None
    for attempt in range(2):
        for ep in ENDPOINTS:
            try:
                req = urllib.request.Request(
                    ep, data=urllib.parse.urlencode({"data": query}).encode(),
                    headers={"User-Agent": "tallinn-cam-locator/1.0 (personal project)"})
                with urllib.request.urlopen(req, timeout=120) as r:
                    els = json.load(r).get("elements", [])
                if els:
                    return els
                print(f"  overpass {ep}: EMPTY, trying next", file=sys.stderr)
            except Exception as e:
                last = e; print(f"  overpass {ep} failed: {e}", file=sys.stderr)
        time.sleep(5)
    if last: raise last
    return []

import os
CACHE = f"{S}/ways-cache.json"

def missing_stems(ways):
    """stems that match no way name in the given set"""
    names = {w.get("tags", {}).get("name", "") for w in ways}
    out = []
    for s in stems:
        rx = re.compile(word_re(s))
        if not any(rx.search(n) for n in names):
            out.append(s)
    return out

if os.path.exists(CACHE):
    ways = json.load(open(CACHE))
    print(f"overpass: {len(ways)} ways from cache", file=sys.stderr)
    miss = missing_stems(ways)
    print(f"refetching {len(miss)} missing stems: {miss}", file=sys.stderr)
    CHUNK = 8
    res_list = sorted({word_re(s) for s in miss})
    for i in range(0, len(res_list), CHUNK):
        alts = "|".join(res_list[i:i+CHUNK])
        q = f'[out:json][timeout:90][bbox:{BBOX}];way["highway"]["name"~"{alts}"];out body geom;'
        try:
            got = overpass(q)
        except Exception as e:
            print(f"  refetch chunk {i//CHUNK+1} FAILED ({e}); continuing without it", file=sys.stderr)
            got = []
        ways += got
        print(f"  refetch chunk {i//CHUNK+1}: {len(got)} ways", file=sys.stderr)
        time.sleep(1)
    json.dump(ways, open(CACHE, "w"))
else:
    ways = []
    CHUNK = 12
    uniq_res = sorted({word_re(s) for s in stems})
    t0 = time.time()
    for i in range(0, len(uniq_res), CHUNK):
        batch = uniq_res[i:i+CHUNK]
        alts = "|".join(batch)
        q = f'[out:json][timeout:90][bbox:{BBOX}];way["highway"]["name"~"{alts}"];out body geom;'
        got = overpass(q)
        ways += got
        print(f"  chunk {i//CHUNK+1}: {len(got)} ways  ({batch[0][:30]}..)", file=sys.stderr)
        if not got: print(f"  !! EMPTY CHUNK: {alts}", file=sys.stderr)
        time.sleep(1)
    json.dump(ways, open(CACHE, "w"))
    print(f"overpass: {len(ways)} ways in {time.time()-t0:.1f}s", file=sys.stderr)

# node -> coord, and stem -> set of node ids
node_coord = {}
stem_nodes = defaultdict(set)
stem_rx = {s: re.compile(word_re(s)) for s in stems}
for w in ways:
    name = w.get("tags", {}).get("name", "")
    nids, geom = w.get("nodes", []), w.get("geometry", [])
    for nid, g in zip(nids, geom):
        if g: node_coord[nid] = (g["lat"], g["lon"])
    matched = [s for s, rx in stem_rx.items() if rx.search(name)]
    for s in matched:
        stem_nodes[s].update(nids)

def centroid(pts):
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))

resolved, unresolved = {}, []
for key, cids in junctions.items():
    sets = [stem_nodes.get(s, set()) for s in key]
    inter = set.intersection(*sets) if all(sets) else set()
    pts = [node_coord[n] for n in inter if n in node_coord]
    if not pts and len(key) == 3:  # triple: try pairwise
        for i in range(3):
            for j in range(i + 1, 3):
                shared = stem_nodes.get(key[i], set()) & stem_nodes.get(key[j], set())
                pts += [node_coord[n] for n in shared if n in node_coord]
    if pts:
        lat, lon = centroid(pts)
        resolved[key] = (round(lat, 6), round(lon, 6), len(pts))
    else:
        unresolved.append(key)

print(f"resolved junctions={len(resolved)} unresolved={len(unresolved)}", file=sys.stderr)
zero = [s for s in stems if not stem_nodes.get(s)]
print(f"stems with ZERO matched ways: {zero}", file=sys.stderr)
for k in unresolved:
    counts = {s: len(stem_nodes.get(s, ())) for s in k}
    print("  UNRESOLVED:", k, "nodecounts:", counts, file=sys.stderr)

# ---------- in-ADS for addresses ----------
def inads(addr):
    url = ("https://inaadress.maaamet.ee/inaadress/gazetteer?" +
           urllib.parse.urlencode({"address": addr + ", Tallinn", "results": 1, "appartment": 0, "unik": 0}))
    req = urllib.request.Request(url, headers={"User-Agent": "tallinn-cam-locator/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode("utf-8", "replace")
    raw = re.sub(r"^[^(]*\(", "", raw); raw = re.sub(r"\);?\s*$", "", raw)  # strip jsonp if any
    d = json.loads(raw)
    a = (d.get("addresses") or [None])[0]
    if not a: return None
    for latk, lonk in (("viitepunkt_b", "viitepunkt_l"), ("b", "l")):
        if a.get(latk) and a.get(lonk):
            return (round(float(a[latk]), 6), round(float(a[lonk]), 6))
    return None

addr_cache = {}
for cid, sp in specs.items():
    if sp["kind"] == "addr":
        a = sp["addr"]
        if a not in addr_cache:
            try: addr_cache[a] = inads(a)
            except Exception as e: addr_cache[a] = None; print("inads fail", a, e, file=sys.stderr)
            time.sleep(0.4)
print("addresses:", json.dumps(addr_cache, ensure_ascii=False), file=sys.stderr)

# ---------- manual fallbacks (approximate, from local knowledge) ----------
MANUAL = {
    "cam024": (59.4247, 24.7880),  # Järvevana enne tunnelit (Ülemiste sõlm)
    "cam026": (59.4196, 24.7566),  # Järvevana raudteeülesõit
    "cam234": (59.4196, 24.7566),
    "cam045": (59.4285, 24.7662),  # Lastekodu tn (bussijaama juures)
    "cam046": (59.4256, 24.7942),  # Ülemiste tunnel (Lasnamäele)
    "cam050": (59.4262, 24.7975),  # Ülemiste tunnel (Mustamäele)
    "cam055": (59.4341, 24.7480),  # Pärnu mnt - Draamateater
    "cam056": (59.4341, 24.7480),
    "cam057": (59.4341, 24.7480),
    "cam065": (59.4335, 24.7440),  # Vabaduse väljak
    "cam073": (59.3888, 24.6812),  # Nõmme keskus
    "cam074": (59.3888, 24.6812),
    "cam075": (59.3888, 24.6812),
    "cam103": (59.4370, 24.7546),  # Viru väljak
    "cam104": (59.4365, 24.7540),
    "cam124": (59.4369, 24.7492),  # Viru tn pollar
    "cam129": (59.4137, 24.7508),  # Tammsaare - Alajaama viadukt
    "cam130": (59.4137, 24.7508),
    "cam141": (59.4424, 24.7494),  # Suur-Rannavärava
    "cam157": (59.4374, 24.7744),  # Gonsiori P&R (Laagna tee algus)
    "cam158": (59.4374, 24.7744),
    "cam159": (59.4374, 24.7744),
    "cam160": (59.4374, 24.7744),
    "cam167": (59.4374, 24.7724),  # Laagna - Selveri (Torupilli Selver)
    "cam168": (59.4374, 24.7724),
    "cam187": (59.4490, 24.8070),  # Pirita tee (Maarjamäe)
    "cam195": (59.4770, 24.8310),  # Merivälja tee
    "cam196": (59.4770, 24.8310),
    "cam199": (59.4065, 24.6855),  # Tammsaare K-Rauta
    "cam200": (59.4417, 24.7448),  # Suurtüki trammitee
    "cam201": (59.4417, 24.7448),
    "cam221": (59.4269, 24.6375),  # Paldiski mnt K-Rauta (Haabersti)
    "cam233": (59.4220, 24.7680),  # Järvevana tee
    "cam237": (59.4220, 24.7680),
    "cam238": (59.4248, 24.7710),  # Järvevana - Filtri tunnel
    "cam239": (59.4248, 24.7710),
    "cam240": (59.4408, 24.7340),  # Vana-Kalamaja pollar
    "cam040": (59.4525, 24.8360),  # Narva mnt - Kose tee
    # grade-separated / odd junctions Overpass can't see as shared nodes
    "cam009": (59.4295, 24.7830),  # Tartu mnt - Peterburi tee viadukt
    "cam084": (59.4295, 24.7830),
    "cam030": (59.4185, 24.7515),  # Järvevana (Delta Plaza)
    "cam087": (59.4162, 24.7420),  # Pärnu mnt - Järvevana viadukt
    "cam088": (59.4162, 24.7420),
    "cam089": (59.4162, 24.7420),
    "cam123": (59.4162, 24.7420),
    "cam164": (59.4162, 24.7420),
    "cam098": (59.4340, 24.8570),  # Peterburi tee - Rahu tee
    "cam131": (59.4382, 24.8688),  # Laagna - Mustakivi
    "cam216": (59.4382, 24.8688),
    "cam217": (59.4382, 24.8688),
    "cam144": (59.4560, 24.7080),  # Sitsi - Paljasaare
    "cam161": (59.4135, 24.7380),  # Tondi P&R
    "cam175": (59.4135, 24.7380),
    "cam165": (59.4635, 24.8760),  # Vana-Narva - Pärnamäe
    "cam166": (59.4635, 24.8760),
    "cam188": (59.4298, 24.7676),  # Tartu mnt - Lubja
    "cam197": (59.4681, 24.8388),  # Merivälja - Kloostrimetsa
    "cam198": (59.4110, 24.7300),  # Tammsaare - Sõjakooli
    "cam224": (59.4400, 24.8830),  # Laagna - Kärberi
    "cam225": (59.4400, 24.8830),
    "cam246": (59.4346, 24.7614),  # Gonsiori - Kivisilla
    "cam247": (59.4345, 24.7570),  # Estonia pst - Laikmaa
    "cam257": (59.4448, 24.7621),  # Logi - Rumbi
}

# ---------- assemble ----------
out = []
for c in cams:
    sp = specs[c["id"]]
    lat = lon = None; how = sp["kind"]; approx = False
    if sp["kind"] == "junction":
        key = tuple(sorted(sp["streets"]))
        if key in resolved: lat, lon = resolved[key][0], resolved[key][1]
    elif sp["kind"] == "addr":
        pt = addr_cache.get(sp["addr"])
        if pt: lat, lon = pt
    if lat is None and c["id"] in MANUAL:
        lat, lon = MANUAL[c["id"]]; how = "manual"; approx = True
    out.append({"id": c["id"], "name": re.sub(r"\*+\s*$", "", c["name"]).strip(),
                "areas": c["areas"], "lat": lat, "lng": lon, "how": how, "approx": approx,
                "spec": sp.get("streets") or sp.get("addr") or sp.get("text")})

json.dump(out, open(f"{S}/cams-geo.json", "w"), ensure_ascii=False, indent=1)
missing = [o for o in out if o["lat"] is None]
print(f"TOTAL {len(out)}, located {len(out)-len(missing)}, missing {len(missing)}", file=sys.stderr)
for o in missing: print("  MISSING:", o["id"], "|", o["name"], "|", o["spec"], file=sys.stderr)

# ---------- final app data ----------
import datetime
app_cams = [{"id": o["id"], "name": o["name"], "areas": o["areas"],
             "lat": o["lat"], "lng": o["lng"], "approx": o["approx"]} for o in out]
final = {"generated": datetime.date.today().isoformat(),
         "source": "https://ristmikud.tallinn.ee",
         "cams": app_cams}
json.dump(final, open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))
print(f"wrote {OUT}", file=sys.stderr)
