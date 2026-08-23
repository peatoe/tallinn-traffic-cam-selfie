/* tallinn cam selfie — city traffic cams as selfie cameras */
"use strict";

const IMG_BASE = "https://ristmikud.tallinn.ee/last/";
const SITE = "https://ristmikud.tallinn.ee/";
const AREAS = {
  ALL: "all", KE: "kesklinn", PT: "põhja-tallinn", KR: "kristiine",
  LA: "lasnamäe", MU: "mustamäe", NO: "nõmme", HA: "haabersti",
  PI: "pirita", P: "p&r", ST: "sadam",
};

const $ = (id) => document.getElementById(id);
const state = {
  cams: [], spots: new Map(), markers: new Map(), byId: new Map(),
  sel: null, selSpot: null, view: "map",
  user: null, userMarker: null, accCircle: null, line: null,
  watching: false, watchId: null,
  previewTimer: null, wakeLock: null, lastCapture: "now",
};

/* ---------- helpers ---------- */
const imgUrl = (id, ts) => `${IMG_BASE}${id}.jpg${ts ? `?t=${ts}` : ""}`;

function haversine(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function bearing(a, b) {
  const toR = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * toR) * Math.cos(b.lat * toR);
  const x = Math.cos(a.lat * toR) * Math.sin(b.lat * toR) -
    Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos((b.lng - a.lng) * toR);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (deg) => COMPASS[Math.round(deg / 45) % 8];
const fmtDist = (m) => m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;

function toast(msg, ms = 3200) {
  const el = $("status");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, ms);
}

/* short view label: the "(suund X)" part, or a trimmed name */
function viewLabel(cam, i) {
  const m = cam.name.match(/\(([^)]*)\)/);
  if (m) return m[1].replace(/^suund\s*/i, "→ ").replace(/^vaade\s*/i, "view ");
  return `view ${i + 1}`;
}
const shortName = (cam) =>
  cam.name.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

/* name + view direction, for lists where cameras stand alone */
const camLabel = (cam) =>
  /\(/.test(cam.name) ? `${shortName(cam)} (${viewLabel(cam, 0)})` : shortName(cam);

function areaName(cam) {
  const letters = cam.areas.filter(a => /^[A-Z]+$/.test(a));
  const tag = letters.find(a => !["P", "ST"].includes(a)) || letters[0] || cam.areas[0];
  return AREAS[tag] || String(tag).toLowerCase();
}

function fmtWhen(when) {
  const d = when instanceof Date ? when : new Date(when);
  return d.toLocaleDateString("et-EE", { day: "2-digit", month: "2-digit" }) + " " +
    d.toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit" });
}

/* ---------- map ---------- */
const TLL_CENTER = L.latLng(59.437, 24.754), TLL_ZOOM = 12;
const map = L.map("map", { zoomControl: false, attributionControl: true })
  .setView(TLL_CENTER, TLL_ZOOM);
L.control.zoom({ position: "bottomright" }).addTo(map);

/* Stamen Toner (hosted by Stadia Maps), recolored black -> Visit Estonia blue.
   The recolor happens on a canvas, pixel by pixel: iOS Safari silently drops
   SVG url() filters on Leaflet's transformed tile pane, so filters are out.
   Canvas tiles are also drawn a hair oversized to close the hairline seams
   phones show at fractional device-pixel offsets. Falls back to plain OSM if
   toner tiles fail (e.g. the domain is not registered with Stadia). */
const DuotoneLayer = L.TileLayer.extend({
  createTile: function (coords, done) {
    const size = this.getTileSize();
    const tile = document.createElement("canvas");
    tile.width = size.x;
    tile.height = size.y;
    tile.style.width = (size.x + 0.75) + "px";
    tile.style.height = (size.y + 0.75) + "px";
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const ctx = tile.getContext("2d");
      ctx.drawImage(img, 0, 0, size.x, size.y);
      try {
        const px = ctx.getImageData(0, 0, size.x, size.y);
        const d = px.data;
        for (let i = 0; i < d.length; i += 4) {
          const v = d[i];               // toner is grayscale: red carries it all
          d[i + 1] = v;                 // black -> #000087, white stays white
          d[i + 2] = 0.471 * v + 135;
        }
        ctx.putImageData(px, 0, 0);
      } catch (e) { /* blocked read: keep the plain tile */ }
      done(null, tile);
    };
    img.onerror = () => done(new Error("tile load failed"), tile);
    img.src = this.getTileUrl(coords);
    return tile;
  },
});

const CAMS_CREDIT = ' · cams: <a href="' + SITE + '">City of Tallinn</a>';
function addOsmFallback() {
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' + CAMS_CREDIT,
  }).addTo(map);
}
(function addToner() {
  const key = (window.APP_CONFIG && window.APP_CONFIG.stadiaApiKey) || "";
  const tonerUrl = "https://tiles.stadiamaps.com/tiles/stamen_toner/{z}/{x}/{y}.png" +
    (key ? "?api_key=" + encodeURIComponent(key) : "");
  const toner = new DuotoneLayer(tonerUrl, {
    maxZoom: 20,
    attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://stamen.com/">Stamen Design</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' + CAMS_CREDIT,
  }).addTo(map);
  let errors = 0, swapped = false;
  toner.on("tileerror", () => {
    if (++errors >= 3 && !swapped) {
      swapped = true;
      map.removeLayer(toner);
      addOsmFallback();
    }
  });
})();

function spotKey(c) { return `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`; }

function markerStyle(on) {
  return {
    radius: on ? 11 : 8,
    color: "#fff", weight: 3, fillOpacity: 1,
    fillColor: on ? "#000087" : "#111",
    className: "cam-dot", // drop shadow lives in css
  };
}

/* favorited spots show as a star instead of a dot (Brand Estonia star, filled) */
function starIcon(on) {
  const s = on ? 34 : 27;
  return L.divIcon({
    className: "",
    html: `<svg class="cam-star" viewBox="10 10 44 44" width="${s}" height="${s}"><path d="M41 47l-8.505-6.025L20 49l5-12.987-10-8.053h13L31.95 15l4.182 12.96L49 27.987l-9 8.026L45 49" fill="${on ? "#000087" : "#111"}" stroke="#fff" stroke-width="4" stroke-linejoin="round"/></svg>`,
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
  });
}

function buildSpots() {
  state.spots.clear();
  for (const c of state.cams) {
    if (c.lat == null) continue;
    const k = spotKey(c);
    if (!state.spots.has(k)) state.spots.set(k, { key: k, lat: c.lat, lng: c.lng, cams: [] });
    state.spots.get(k).cams.push(c);
  }
}

function makeSpotMarker(spot) {
  const on = state.selSpot === spot.key;
  const fav = spot.cams.some(c => isFav(c.id));
  const m = fav
    ? L.marker([spot.lat, spot.lng], { icon: starIcon(on), zIndexOffset: 500 })
    : L.circleMarker([spot.lat, spot.lng], markerStyle(on));
  m.addTo(map)
    .bindTooltip(shortName(spot.cams[0]), { className: "cam-tip", direction: "top", offset: [0, -8] })
    .on("click", () => selectSpot(spot));
  return m;
}

function renderMarkers() {
  for (const m of state.markers.values()) m.remove();
  state.markers.clear();
  for (const spot of state.spots.values()) state.markers.set(spot.key, makeSpotMarker(spot));
}

/* swap a single spot's marker; a full re-render during a zoom animation can
   corrupt leaflet's transition (map ends up at world zoom) */
function refreshSpotMarker(key) {
  const spot = state.spots.get(key);
  if (!spot) return;
  const old = state.markers.get(key);
  if (old) old.remove();
  state.markers.set(key, makeSpotMarker(spot));
}

/* ---------- selection ---------- */
function selectSpot(spot, camId) {
  state.selSpot = spot.key;
  const cams = spot.cams;
  const cam = camId ? cams.find(c => c.id === camId) || cams[0] : cams[0];
  state.sel = cam;
  renderMarkers();
  openSheet(spot, cam);
  updateLine();
  const target = L.latLng(spot.lat, spot.lng);
  if (state.user && !userIsFar()) { // fitting a far-away user would zoom out past the city
    map.fitBounds(L.latLngBounds([state.user, target]).pad(0.25));
  } else {
    map.setView(target, Math.max(map.getZoom(), 15));
  }
}

function openSheet(spot, cam) {
  $("cam-title").textContent = shortName(cam);
  $("cam-area").textContent = areaName(cam);
  $("cam-approx").hidden = !cam.approx;
  $("approx-note").hidden = !cam.approx;
  updateFavBtn();

  /* view switcher for multi-cam spots */
  let sw = document.getElementById("view-switch");
  if (sw) sw.remove();
  if (spot.cams.length > 1) {
    sw = document.createElement("div");
    sw.id = "view-switch";
    sw.className = "chips";
    sw.style.borderBottom = "none";
    sw.style.padding = "0 0 10px";
    spot.cams.forEach((c, i) => {
      const b = document.createElement("button");
      b.className = "chip" + (c.id === cam.id ? " on" : "");
      b.textContent = viewLabel(c, i);
      b.onclick = () => selectSpot(spot, c.id);
      sw.appendChild(b);
    });
    $("cam-title").after(sw);
  }

  $("dir-google").href =
    `https://www.google.com/maps/dir/?api=1&destination=${spot.lat},${spot.lng}&travelmode=walking`;
  $("dir-apple").href = `https://maps.apple.com/?daddr=${spot.lat},${spot.lng}&dirflg=w`;

  updateDistance();
  startPreview(cam);
  renderShots();
  $("sheet").hidden = false;
  $("sheet").scrollTop = 0;
  updateSheetShade();                      // layout is ready: set the state now
  requestAnimationFrame(updateSheetShade); // and settle once painted
}

/* the bottom shade's opacity tracks how much is left to scroll: full while
   plenty remains, melting away over the last 48px instead of snapping off */
function updateSheetShade() {
  const sh = $("sheet");
  const clamp = (v) => Math.max(0, Math.min(1, v)).toFixed(3);
  const remaining = sh.scrollHeight - sh.scrollTop - sh.clientHeight;
  sh.style.setProperty("--shade", clamp(remaining / 48));
  sh.style.setProperty("--shade-top", clamp(sh.scrollTop / 48));
}

function closeSheet() {
  $("sheet").hidden = true;
  stopPreview();
  state.sel = null; state.selSpot = null;
  if (state.line) { state.line.remove(); state.line = null; }
  renderMarkers();
}

function updateDistance() {
  const el = $("cam-dist");
  if (!state.user || !state.sel) { el.hidden = true; return; }
  const t = { lat: state.sel.lat, lng: state.sel.lng };
  const d = haversine(state.user, t);
  const b = bearing(state.user, t);
  $("dist-text").textContent = `${fmtDist(d)} ${compass(b)}`;
  $("dist-arrow").style.transform = `rotate(${b}deg)`;
  el.hidden = false;
}

function updateLine() {
  if (state.line) { state.line.remove(); state.line = null; }
  if (!state.user || !state.sel) return;
  state.line = L.polyline([state.user, [state.sel.lat, state.sel.lng]], {
    color: "#000087", weight: 3, dashArray: "6 8", opacity: .8,
  }).addTo(map);
}

/* ---------- live preview ---------- */
const BLANK_PX = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function startPreview(cam) {
  stopPreview();
  const img = $("preview-img");
  img.src = BLANK_PX; // never show the previous camera's frame under this one's name
  $("preview-time").textContent = "…";
  const load = () => {
    const ts = Date.now();
    const pre = new Image();
    pre.onload = () => {
      img.src = pre.src;
      $("preview-time").textContent = "live · " + new Date().toLocaleTimeString("et-EE");
    };
    pre.src = imgUrl(cam.id, ts);
  };
  load();
  state.previewTimer = setInterval(load, 5000);
}
function stopPreview() {
  clearInterval(state.previewTimer);
  state.previewTimer = null;
}

/* ---------- favorites (persisted in the browser) ---------- */
const FAVS_KEY = "tcs-favs-v1";

function loadFavs() {
  try { return JSON.parse(localStorage.getItem(FAVS_KEY)) || []; }
  catch { return []; }
}
function saveFavs() {
  try { localStorage.setItem(FAVS_KEY, JSON.stringify(favs)); } catch { /* full */ }
}
let favs = loadFavs(); // [camId, newest first]

const isFav = (id) => favs.includes(id);

function updateFavBtn() {
  const b = $("btn-fav");
  const on = !!state.sel && isFav(state.sel.id);
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", String(on));
  b.title = on ? "Remove from favorites" : "Save to favorites";
  b.setAttribute("aria-label", b.title);
}

function toggleFav(id) {
  if (isFav(id)) favs = favs.filter(f => f !== id);
  else favs.unshift(id);
  saveFavs();
  updateFavBtn();
  updateNavCounts();
  const cam = state.byId.get(id);
  if (cam) refreshSpotMarker(spotKey(cam)); // star <-> dot for just this spot
  if (!$("favs").hidden) renderFavs();
  const star = listStars.get(id);
  if (star) {
    star.classList.toggle("on", isFav(id));
    star.setAttribute("aria-pressed", String(isFav(id)));
    star.title = isFav(id) ? "Remove from favorites" : "Save to favorites";
  }
}

const STAR_SVG = '<svg class="ico" width="20" height="20" aria-hidden="true"><use href="#i-star"/></svg>';

/* name, area badge, approx marker, distance; shared by favorites and list rows */
function camRowMain(cam) {
  const main = document.createElement("div");
  main.className = "fav-main";
  const name = document.createElement("div");
  name.className = "fav-name";
  name.textContent = camLabel(cam);
  const meta = document.createElement("div");
  meta.className = "fav-meta";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = areaName(cam);
  meta.appendChild(badge);
  if (cam.approx) {
    const ap = document.createElement("span");
    ap.textContent = "≈ approximate location";
    meta.appendChild(ap);
  }
  const dist = document.createElement("span");
  dist.className = "fav-dist";
  if (state.user) {
    dist.textContent = `${fmtDist(haversine(state.user, cam))} ${compass(bearing(state.user, cam))}`;
  }
  meta.appendChild(dist);
  main.appendChild(name);
  main.appendChild(meta);
  return { main, dist };
}

function rowGoesTo(row, cam) {
  const go = () => {
    $("favs").hidden = true;
    selectSpot(state.spots.get(spotKey(cam)), cam.id);
  };
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.setAttribute("aria-label", `Open ${shortName(cam)}`);
  row.onclick = go;
  row.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
}

const FAVSORT_KEY = "tcs-favsort-v1";
let favSort = (() => {
  try { return sessionStorage.getItem(FAVSORT_KEY) || "added"; } catch (e) { return "added"; }
})();

function setFavSort(mode) {
  if (mode === "near" && !state.user) {
    toast("turn on location to sort by distance", 2600);
    return;
  }
  favSort = mode;
  try { sessionStorage.setItem(FAVSORT_KEY, mode); } catch (e) { /* fine */ }
  renderFavs();
}

function renderFavs() {
  const list = $("favs-list");
  list.innerHTML = "";
  /* sort chips: "nearest" needs a location; fall back to recently added */
  const effective = favSort === "near" && !state.user ? "added" : favSort;
  for (const b of document.querySelectorAll("#favs-sort .chip")) {
    b.classList.toggle("on", b.dataset.sort === effective);
    b.classList.toggle("dim", b.dataset.sort === "near" && !state.user);
  }
  const cams = favs.map(id => state.cams.find(c => c.id === id)).filter(Boolean);
  if (effective === "near") cams.sort((a, b) => haversine(state.user, a) - haversine(state.user, b));
  else if (effective === "abc") cams.sort((a, b) => shortName(a).localeCompare(shortName(b), "et"));
  /* "added" keeps the stored order: newest star first */
  if (!cams.length) {
    const p = document.createElement("p");
    p.className = "empty-note";
    p.textContent = "no favorites yet. open a camera on the map and tap the star to keep it here for later.";
    list.appendChild(p);
    return;
  }
  for (const cam of cams) {
    const row = document.createElement("div");
    row.className = "fav-row";
    rowGoesTo(row, cam);

    const rm = document.createElement("button");
    rm.className = "fav-remove";
    rm.title = "Remove from favorites";
    rm.setAttribute("aria-label", "Remove from favorites");
    rm.innerHTML = STAR_SVG;
    rm.onclick = (e) => { e.stopPropagation(); toggleFav(cam.id); };

    row.appendChild(camRowMain(cam).main);
    row.appendChild(rm);
    list.appendChild(row);
  }
}

/* ---------- map / list view ---------- */
const VIEW_KEY = "tcs-view-v1";
const listStars = new Map(); // camId -> star button in the list
const listDists = new Map(); // camId -> distance span in the list

function setView(v) {
  state.view = v;
  try { sessionStorage.setItem(VIEW_KEY, v); } catch { /* full */ }
  $("view-map").classList.toggle("on", v === "map");
  $("view-list").classList.toggle("on", v === "list");
  $("view-map").setAttribute("aria-pressed", String(v === "map"));
  $("view-list").setAttribute("aria-pressed", String(v === "list"));
  if (v === "list") { renderList(); startListRefresh(); }
  else stopListRefresh();
  $("list").hidden = v !== "list";
}

/* ---------- list feed loading ----------
   A bounded-concurrency loader instead of timed batches. Rules:
   - an in-flight load is never aborted (that was how feeds got stuck);
     only a load hung past LIST_STALL_MS is restarted, once per tick
   - on open, every camera queues once, nearest first
   - the 30 s tick refreshes only what is on screen; off-screen frames are
     topped up the moment they scroll in (old frame stays until the new
     one has arrived, so nothing blanks)
   - a feed that fails LIST_DEAD_AFTER times shows "no signal" instead of
     spinning forever, and still retries while visible */
const LIST_REFRESH_MS = 30000;
const LIST_MAX_INFLIGHT = 24;
const LIST_STALL_MS = 25000;
const LIST_DEAD_AFTER = 3;

let listRefreshTimer = null;
let listIO = null;
const feedQueue = [];          // {im, swap}; front = loads next
let feedInflight = 0;
const feedVisible = new Set(); // imgs currently intersecting the viewport

function startListRefresh() {
  stopListRefresh();
  listRefreshTimer = setInterval(refreshListFeeds, LIST_REFRESH_MS);
}
function stopListRefresh() {
  clearInterval(listRefreshTimer);
  listRefreshTimer = null;
}

function feedSt(im) {
  if (!im._feed) im._feed = { status: "idle", ts: 0, startedAt: 0, attempts: 0, queued: false, counted: false, token: 0 };
  return im._feed;
}

function enqueueFeed(im, { swap = false, front = false } = {}) {
  const st = feedSt(im);
  if (st.queued || st.status === "loading" || !im.isConnected) return;
  st.queued = true;
  if (front) feedQueue.unshift({ im, swap }); else feedQueue.push({ im, swap });
  pumpFeeds();
}

function pumpFeeds() {
  while (feedInflight < LIST_MAX_INFLIGHT && feedQueue.length) {
    const { im, swap } = feedQueue.shift();
    const st = feedSt(im);
    st.queued = false;
    if (!im.isConnected || state.view !== "list") continue;
    const token = ++st.token;
    st.status = "loading";
    st.startedAt = Date.now();
    st.counted = true;
    feedInflight++;
    const url = imgUrl(im.dataset.camId, Date.now());
    const settle = (ok) => {
      if (st.token !== token) return; // superseded by a stall restart
      if (st.counted) { feedInflight--; st.counted = false; }
      settleFeed(im, ok);
      pumpFeeds();
    };
    if (swap) {
      const pre = new Image(); // keep the old frame painted until the new one is in
      pre.onload = () => { if (st.token === token) { im.onload = im.onerror = null; im.src = pre.src; } settle(true); };
      pre.onerror = () => settle(false);
      pre.src = url;
    } else {
      im.onload = () => { im.onload = im.onerror = null; settle(true); };
      im.onerror = () => { im.onload = im.onerror = null; settle(false); };
      im.src = url;
    }
  }
}

function settleFeed(im, ok) {
  const st = feedSt(im);
  const wrap = im.parentElement;
  if (ok) {
    st.status = "loaded"; st.ts = Date.now(); st.attempts = 0;
    im.style.visibility = "";
    if (wrap) { wrap.classList.add("loaded"); wrap.classList.remove("dead"); }
  } else {
    st.status = "error"; st.attempts++;
    im.style.visibility = "hidden";
    if (wrap) {
      wrap.classList.remove("loaded");
      if (st.attempts >= LIST_DEAD_AFTER) wrap.classList.add("dead");
    }
  }
}

/* a re-render carries an already-loaded frame over so the card never re-spins */
function carryFeed(im, prevSrc) {
  const st = feedSt(im);
  st.status = "loaded";
  st.ts = Number(new URLSearchParams(prevSrc.split("?")[1] || "").get("t")) || Date.now();
  im.src = prevSrc; // instant, from cache
  im.parentElement.classList.add("loaded");
}

function setupListIO() {
  if (listIO) listIO.disconnect();
  feedVisible.clear();
  listIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const im = e.target;
      const st = feedSt(im);
      if (!e.isIntersecting) { feedVisible.delete(im); continue; }
      feedVisible.add(im);
      if (st.status === "idle" || st.status === "error") enqueueFeed(im, { front: true });
      else if (st.status === "loaded" && Date.now() - st.ts > LIST_REFRESH_MS) enqueueFeed(im, { swap: true, front: true });
    }
  }, { root: $("list"), rootMargin: "200px 0px" });
}

function refreshListFeeds() {
  if (document.hidden || state.view !== "list") return;
  if (state.sel) return; // camera sheet is on top; its live preview has priority
  const now = Date.now();
  for (const im of feedVisible) {
    const st = feedSt(im);
    if (st.status === "loaded" && now - st.ts >= LIST_REFRESH_MS - 500) enqueueFeed(im, { swap: true, front: true });
    else if (st.status === "error") enqueueFeed(im, { front: true });
  }
  /* watchdog: restart anything hung, wherever it is, at most once per tick */
  for (const im of $("list").querySelectorAll(".cam-card-img img")) {
    const st = feedSt(im);
    if (st.status === "loading" && now - st.startedAt > LIST_STALL_MS) {
      if (st.counted) { feedInflight--; st.counted = false; }
      st.token++; // orphan the hung load's callbacks
      st.status = "idle";
      enqueueFeed(im, { front: feedVisible.has(im) });
    }
  }
  pumpFeeds();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.view === "list") refreshListFeeds();
});

/* ---------- ios add-to-home-screen hint ----------
   safari on iphone/ipad only, never when already installed, after 30 s of
   use at a quiet moment, dismissible, and at most once every 30 days */
const A2HS_KEY = "tcs-a2hs-v1";
const A2HS_DELAY_MS = 30000;
const A2HS_SNOOZE_MS = 30 * 86400000;

/* android (chrome/edge/samsung): the browser hands us a native install
   prompt; the card then shows a real install button instead of instructions */
let deferredInstall = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
});
window.addEventListener("appinstalled", () => {
  deferredInstall = null;
  $("a2hs").hidden = true;
});

function isIosSafari() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // ipados
  const safari = /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA/.test(ua);
  return ios && safari;
}

function maybeOfferA2hs() {
  const force = new URLSearchParams(location.search).get("a2hs"); // "1" = ios preview, "android" = android preview
  if (!force) {
    if (navigator.standalone) return;             // already on the home screen
    if (matchMedia("(display-mode: standalone)").matches) return;
    if (!isIosSafari() && !/Android/.test(navigator.userAgent)) return;
    try {
      const last = Number(localStorage.getItem(A2HS_KEY)) || 0;
      if (Date.now() - last < A2HS_SNOOZE_MS) return;
    } catch (e) { /* show anyway */ }
  }
  let tries = 0;
  const overlays = ["sheet", "result", "gallery", "favs", "about", "countdown", "confirm", "away", "welcome"];
  const attempt = () => {
    if (overlays.some(id => !$(id).hidden)) {      // busy: wait for a quiet moment
      if (++tries < 10) setTimeout(attempt, 10000);
      return;
    }
    const ios = force === "1" || (!force && isIosSafari());
    const android = force === "android" || (!force && !ios && !!deferredInstall);
    if (!ios && !android) {                        // android's prompt event may still be coming
      if (++tries < 10) setTimeout(attempt, 10000);
      return;
    }
    $("a2hs-how").hidden = !ios;
    $("a2hs-install").hidden = !android;
    $("a2hs").hidden = false;
    try { localStorage.setItem(A2HS_KEY, String(Date.now())); } catch (e) { /* fine */ }
    setTimeout(() => { $("a2hs").hidden = true; }, 22000);
  };
  setTimeout(attempt, force ? 1500 : A2HS_DELAY_MS);
}

$("a2hs-install").onclick = async () => {
  const p = deferredInstall;
  $("a2hs").hidden = true;
  if (!p) return; // dev preview without a real prompt
  deferredInstall = null;
  p.prompt();
  try { await p.userChoice; } catch (e) { /* dismissed */ }
};

$("a2hs-x").onclick = () => { $("a2hs").hidden = true; };

function renderList() {
  const box = $("list");
  /* keep already-loaded frames across a re-render (e.g. the nearest-first re-sort) */
  const prevSrcs = new Map(
    [...box.querySelectorAll(".cam-card-img img")]
      .filter(im => im.getAttribute("src") && feedSt(im).status === "loaded")
      .map(im => [im.dataset.camId, im.src]));
  box.innerHTML = "";
  setupListIO(); // drops the old observer and visibility set; stale queue entries fall out via isConnected
  listStars.clear();
  listDists.clear();
  state.listSortedByDist = !!state.user;
  const cams = [...state.cams].sort((a, b) =>
    state.user
      ? haversine(state.user, a) - haversine(state.user, b)
      : shortName(a).localeCompare(shortName(b), "et"));
  for (const cam of cams) {
    const card = document.createElement("div");
    card.className = "cam-card";
    rowGoesTo(card, cam);

    const imgWrap = document.createElement("div");
    imgWrap.className = "cam-card-img";
    const spin = document.createElement("div");
    spin.className = "cam-loading";
    spin.innerHTML = '<svg class="ico" width="26" height="26" aria-hidden="true"><use href="#i-loading"/></svg>';
    imgWrap.appendChild(spin);
    const dead = document.createElement("div");
    dead.className = "cam-dead";
    dead.innerHTML = '<svg class="ico" width="7" height="14" aria-hidden="true"><use href="#i-exclaim"/></svg><span>no signal</span>';
    imgWrap.appendChild(dead);
    const im = document.createElement("img");
    im.alt = cam.name;
    im.decoding = "async";
    im.dataset.camId = cam.id;
    imgWrap.appendChild(im);

    const star = document.createElement("button");
    star.className = "cam-card-star" + (isFav(cam.id) ? " on" : "");
    star.title = isFav(cam.id) ? "Remove from favorites" : "Save to favorites";
    star.setAttribute("aria-label", "Favorite");
    star.setAttribute("aria-pressed", String(isFav(cam.id)));
    star.innerHTML = '<svg class="ico" width="17" height="17" aria-hidden="true"><use href="#i-star"/></svg>';
    star.onclick = (e) => { e.stopPropagation(); toggleFav(cam.id); };
    listStars.set(cam.id, star);
    imgWrap.appendChild(star);

    const name = document.createElement("div");
    name.className = "cam-card-name";
    name.textContent = camLabel(cam);

    const meta = document.createElement("div");
    meta.className = "cam-card-meta";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = areaName(cam);
    meta.appendChild(badge);
    if (cam.approx) {
      const ap = document.createElement("span");
      ap.textContent = "≈";
      ap.title = "approximate location";
      meta.appendChild(ap);
    }
    const dist = document.createElement("span");
    dist.className = "cam-card-dist";
    if (state.user) {
      dist.textContent = `${fmtDist(haversine(state.user, cam))} ${compass(bearing(state.user, cam))}`;
    }
    meta.appendChild(dist);
    listDists.set(cam.id, dist);

    card.appendChild(imgWrap);
    card.appendChild(name);
    card.appendChild(meta);
    box.appendChild(card);

    const prev = prevSrcs.get(cam.id);
    if (prev) carryFeed(im, prev);
    else enqueueFeed(im); // DOM order = nearest first, so the top loads first
    listIO.observe(im);
  }
}

function updateListDists() {
  if (!state.user || $("list").hidden) return;
  if (!state.listSortedByDist) { renderList(); return; } // first fix: re-sort nearest first
  for (const [id, el] of listDists) {
    const cam = state.byId.get(id);
    if (cam) el.textContent = `${fmtDist(haversine(state.user, cam))} ${compass(bearing(state.user, cam))}`;
  }
}

/* ---------- shots (persisted in the browser) ----------
   metadata -> localStorage; pixels -> Cache Storage (opaque responses),
   served back after refresh by sw.js under shots/<sid>              */
const SHOTS_KEY = "tcs-shots-v1";
const SHOTS_CACHE = "tcs-shots-v1";
const sessionUrls = new Map(); // sid -> live ?t= url usable this session

function loadShots() {
  try { return JSON.parse(localStorage.getItem(SHOTS_KEY)) || []; }
  catch { return []; }
}
function saveShots(list) {
  try { localStorage.setItem(SHOTS_KEY, JSON.stringify(list)); } catch { /* full */ }
}
let shots = loadShots(); // [{sid, camId, label, when, stored}]

/* The live ?t= url is not safe to reuse, because the city sends no cache-control and ignores the timestamp. */
function shotSrc(s) {
  const swReady = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  if (s.stored && swReady) return `shots/${s.sid}`;
  return sessionUrls.get(s.sid) || `shots/${s.sid}`;
}

async function persistShot(sid, url) {
  if (!("caches" in window)) return false;
  try {
    const resp = await fetch(url, { mode: "no-cors", cache: "force-cache" });
    const c = await caches.open(SHOTS_CACHE);
    await c.put(new Request(`shots/${sid}`), resp);
    return true;
  } catch { return false; }
}

async function deleteShot(sid) {
  shots = shots.filter(s => s.sid !== sid);
  saveShots(shots);
  sessionUrls.delete(sid);
  try {
    const c = await caches.open(SHOTS_CACHE);
    await c.delete(new Request(`shots/${sid}`));
  } catch { /* ignore */ }
}

function askConfirm(title = "delete this photo?", sub = "it will be removed from your shots in this browser.") {
  return new Promise((resolve) => {
    const box = $("confirm");
    $("confirm-title").textContent = title;
    $("confirm-sub").textContent = sub;
    const yes = $("confirm-yes"), no = $("confirm-no");
    const done = (v) => {
      box.hidden = true;
      yes.onclick = no.onclick = box.onclick = null;
      resolve(v);
    };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    box.onclick = (e) => { if (e.target === box) done(false); };
    box.hidden = false;
  });
}

async function confirmDelete(sid, after) {
  if (await askConfirm()) {
    await deleteShot(sid);
    renderShots();
    if (!$("gallery").hidden) renderGallery();
    updateNavCounts();
    if (after) after();
  }
}

async function addShot(url, cam, label, opts = {}) {
  const sid = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  sessionUrls.set(sid, url);
  const shot = { sid, camId: cam.id, label, when: new Date().toISOString(), stored: false };
  if (opts.clip) { shot.clip = opts.clip; shot.seq = opts.seq; }
  shot.stored = await persistShot(sid, url);
  shots.unshift(shot);
  if (opts.quiet) return shot; // a recording saves and renders once, at the end
  saveShots(shots);
  renderShots();
  updateNavCounts();
  return shot;
}

async function deleteClip(id) {
  for (const f of framesOfClip(id)) await deleteShot(f.sid);
}

async function confirmDeleteClip(id, after) {
  const n = framesOfClip(id).length;
  if (await askConfirm("delete this clip?", `all ${n} frames will be removed from this browser.`)) {
    await deleteClip(id);
    renderShots();
    if (!$("gallery").hidden) renderGallery();
    updateNavCounts();
    if (after) after();
  }
}

function framesOfClip(id) {
  return shots.filter(s => s.clip === id).sort((a, b) => a.seq - b.seq);
}

/* photos and clips, newest first; a clip collapses to one entry */
function groupItems(list) {
  const items = [], seen = new Set();
  for (const s of list) {
    if (!s.clip) { items.push({ type: "photo", shot: s }); continue; }
    if (seen.has(s.clip)) continue;
    seen.add(s.clip);
    const frames = list.filter(x => x.clip === s.clip).sort((a, b) => a.seq - b.seq);
    items.push({ type: "clip", id: s.clip, frames, shot: frames[0] });
  }
  return items;
}

function makeClipX(id, small, after) {
  const x = document.createElement("button");
  x.className = "shot-x" + (small ? " shot-x-sm" : "");
  x.setAttribute("aria-label", "Delete clip");
  x.textContent = "×";
  x.onclick = (e) => { e.stopPropagation(); confirmDeleteClip(id, after); };
  return x;
}

function makeShotX(sid, small, after) {
  const x = document.createElement("button");
  x.className = "shot-x" + (small ? " shot-x-sm" : "");
  x.setAttribute("aria-label", "Delete photo");
  x.textContent = "×";
  x.onclick = (e) => { e.stopPropagation(); confirmDelete(sid, after); };
  return x;
}

/* one side-scrolling strip of thumbnails; used by the sheet and the gallery.
   takes grouped items, so a clip shows as a single badged thumbnail */
function fillStrip(strip, items, withWhen) {
  for (const it of items) {
    const wrap = document.createElement("div");
    wrap.className = "shot-thumb";
    const im = document.createElement("img");
    im.src = shotSrc(it.shot);
    im.alt = it.type === "clip" ? `clip, ${it.frames.length} frames` : it.shot.label;
    im.onclick = () => {
      if (it.type === "clip") { openClip(it.id); return; }
      const cam = state.cams.find(c => c.id === it.shot.camId) || state.sel;
      showResult([it.shot], cam);
    };
    im.onerror = () => { wrap.remove(); };
    wrap.appendChild(im);
    if (it.type === "clip") {
      const b = document.createElement("div");
      b.className = "clip-badge";
      const dot = document.createElement("span");
      dot.className = "rec-dot";
      b.appendChild(dot);
      b.appendChild(document.createTextNode(`${it.frames.length} frames`));
      wrap.appendChild(b);
      wrap.appendChild(makeClipX(it.id, true));
    } else {
      wrap.appendChild(makeShotX(it.shot.sid, true));
    }
    if (withWhen) {
      const t = document.createElement("div");
      t.className = "shot-when";
      t.textContent = fmtWhen(it.shot.when);
      wrap.appendChild(t);
    }
    strip.appendChild(wrap);
  }
}

function renderShots() {
  const strip = $("shots-strip");
  strip.innerHTML = "";
  const mine = shots.filter(s => state.sel && s.camId === state.sel.id);
  $("shots").hidden = mine.length === 0;
  fillStrip(strip, groupItems(mine).slice(0, 20), false);
}

function pulseShots() {
  const el = $("shots");
  if (el.hidden) return;
  el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---------- gallery (all photos, grouped by camera) ---------- */
function renderGallery() {
  const body = $("gal-body");
  body.innerHTML = "";
  if (!shots.length) {
    const p = document.createElement("p");
    p.className = "empty-note";
    p.textContent = "no photos yet. pick a camera on the map, walk there, start a countdown, wave.";
    body.appendChild(p);
    return;
  }
  const groups = new Map(); // camId -> shots, newest first; section order = newest shot first
  for (const s of shots) {
    if (!groups.has(s.camId)) groups.set(s.camId, []);
    groups.get(s.camId).push(s);
  }
  for (const [camId, list] of groups) {
    const cam = state.cams.find(c => c.id === camId);
    const sec = document.createElement("section");
    sec.className = "gal-sec";

    const h = document.createElement("button");
    h.className = "gal-cam";
    if (cam) {
      h.textContent = `${camLabel(cam)} ›`;
      h.title = "Open this camera";
      h.onclick = () => {
        $("gallery").hidden = true;
        selectSpot(state.spots.get(spotKey(cam)), cam.id);
      };
    } else {
      h.textContent = `camera ${camId} (no longer listed)`;
      h.disabled = true;
      h.classList.add("gal-cam-off");
    }

    const items = groupItems(list);
    const nClips = items.filter(i => i.type === "clip").length;
    const nPhotos = items.length - nClips;
    const parts = [];
    if (nPhotos) parts.push(`${nPhotos} ${nPhotos === 1 ? "photo" : "photos"}`);
    if (nClips) parts.push(`${nClips} ${nClips === 1 ? "clip" : "clips"}`);
    const meta = document.createElement("div");
    meta.className = "gal-meta";
    meta.textContent = parts.join(" · ");

    const strip = document.createElement("div");
    strip.className = "shots-strip";
    fillStrip(strip, items, true);

    sec.appendChild(h);
    sec.appendChild(meta);
    sec.appendChild(strip);
    body.appendChild(sec);
  }
}

/* ---------- nav counts ---------- */
function updateNavCounts() {
  const g = $("count-gallery"), f = $("count-favs");
  const items = groupItems(shots).length;
  g.hidden = items === 0;
  g.textContent = items;
  f.hidden = favs.length === 0;
  f.textContent = favs.length;
}

/* ---------- capture ---------- */
function grabFrame(cam, label) {
  return new Promise((resolve) => {
    const url = imgUrl(cam.id, Date.now());
    const im = new Image();
    im.onload = () => resolve({ url, cam, label, when: new Date() });
    im.onerror = () => resolve(null);
    im.src = url;
  });
}

async function photoNow() {
  if (!state.sel) return;
  state.lastCapture = "now";
  const cam = state.sel;
  toast("grabbing the frame…", 1500);
  const frame = await grabFrame(cam, "now");
  if (!frame) { toast("camera image failed to load"); return; }
  const shot = await addShot(frame.url, cam, "now");
  showResult([shot], cam);
}

/* ---------- countdown ---------- */
let audioCtx = null;
function beep(freq, dur, gain = 0.25) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = freq; o.type = "sine";
    g.gain.value = gain;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + dur);
  } catch (e) { /* silent */ }
}

async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator) {
      state.wakeLock = await navigator.wakeLock.request("screen");
    } else if (state.wakeLock) {
      await state.wakeLock.release(); state.wakeLock = null;
    }
  } catch (e) { /* not critical */ }
}

const HINT = "get in front of the camera & wave. stay off the road";
let countdownAbort = null;
async function countdownPhoto(seconds) {
  if (!state.sel) return;
  const cam = state.sel;
  state.lastCapture = seconds;
  const overlay = $("countdown"), num = $("countdown-num");
  $("countdown-cam").textContent = shortName(cam);
  overlay.classList.remove("flash");
  num.classList.remove("word", "hot");
  document.querySelector(".countdown-hint").textContent = HINT;
  overlay.hidden = false;
  keepAwake(true);
  countdownAbort = { stop: false };
  const myAbort = countdownAbort;

  for (let s = seconds; s > 0; s--) {
    if (myAbort.stop) { keepAwake(false); return; }
    num.textContent = s;
    num.classList.toggle("hot", s <= 3);
    num.classList.remove("tick"); void num.offsetWidth; num.classList.add("tick");
    beep(s <= 3 ? 1200 : 800, 0.12, s <= 3 ? 0.35 : 0.18);
    await new Promise(r => setTimeout(r, 1000));
  }
  if (myAbort.stop) { keepAwake(false); return; }

  overlay.classList.add("flash");
  num.textContent = "smile!";
  num.classList.add("word");
  num.classList.remove("hot");
  beep(1600, 0.5, 0.4);

  /* burst: three chances to be in frame, spread over 8 s */
  const grabbed = [];
  const plan = [["at zero", 0], ["+4 s", 4000], ["+8 s", 8000]];
  const t0 = Date.now();
  const hint = document.querySelector(".countdown-hint");
  for (let i = 0; i < plan.length; i++) {
    const [label, offset] = plan[i];
    const wait = t0 + offset - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    if (myAbort.stop) break;
    hint.textContent = `grabbing photo ${i + 1} / ${plan.length}…`;
    const frame = await grabFrame(cam, label);
    if (frame) grabbed.push(await addShot(frame.url, cam, label));
  }
  hint.textContent = HINT;
  num.classList.remove("word");
  keepAwake(false);
  overlay.hidden = true;
  if (!myAbort.stop) {
    if (grabbed.length) showResult(grabbed, cam);
    else toast("could not load camera frames. check your connection");
  }
}

/* ---------- clips: a time lapse from one camera ----------
   the cams put out a new frame every second, so that is the sampling rate */
const CLIP_FRAMES = 30;
const CLIP_INTERVAL_MS = 1000;
const CLIP_PREROLL = 3;

let recAbort = null;
let recPhase = "idle"; // idle | intro | count | live

const fmtRec = (secs) => `0:${String(Math.floor(secs)).padStart(2, "0")}`;

/* tapping record only opens the view; nothing runs until start is pressed */
function openRecorder() {
  if (!state.sel) return;
  warnIfStorageTight();
  recPhase = "intro";
  $("rec-cam").textContent = shortName(state.sel);
  $("rec-intro").hidden = false;
  $("rec-num").hidden = true;
  $("rec-stage").hidden = true;
  $("rec-cancel").textContent = "cancel";
  $("recorder").hidden = false;
  keepAwake(true);
}

async function startRecording() {
  const cam = state.sel;
  if (!cam || recPhase !== "intro") return;
  recAbort = { stop: false };
  const my = recAbort;

  recPhase = "count";
  $("rec-intro").hidden = true;
  const num = $("rec-num");
  num.hidden = false;
  for (let i = CLIP_PREROLL; i > 0; i--) {
    if (my.stop) return;
    num.textContent = i;
    num.classList.add("hot");
    num.classList.remove("tick"); void num.offsetWidth; num.classList.add("tick");
    beep(1200, 0.12, 0.35);
    await new Promise(r => setTimeout(r, 1000));
  }
  if (my.stop) return;

  recPhase = "live";
  num.hidden = true;
  num.classList.remove("hot");
  const img = $("rec-img");
  img.src = BLANK_PX;
  $("rec-stage").hidden = false;
  $("rec-cancel").textContent = "stop";
  beep(1600, 0.3, 0.35);

  const clipId = `c${Date.now()}`;
  const frames = [];
  const t0 = Date.now();
  $("rec-time").textContent = "0:00";

  for (let i = 0; i < CLIP_FRAMES; i++) {
    const wait = t0 + i * CLIP_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    if (my.stop) break;
    const frame = await grabFrame(cam, `frame ${i + 1}`);
    if (frame) {
      if (!my.stop) img.src = frame.url; // the monitor shows the frame just captured
      frames.push(await addShot(frame.url, cam, `frame ${i + 1}`, { clip: clipId, seq: i, quiet: true }));
      $("rec-time").textContent = fmtRec(frames.length); 
    }
  }
  beep(900, 0.25, 0.3);
  finishRecording(my, frames, cam, clipId);
}

function finishRecording(abort, frames, cam, clipId) {
  recPhase = "idle";
  $("recorder").hidden = true;
  keepAwake(false);
  if (frames.length === 1) {                          // one frame is just a photo
    delete frames[0].clip;
    delete frames[0].seq;
  }
  saveShots(shots);
  renderShots();
  updateNavCounts();
  if (!frames.length) {
    if (!abort.stop) toast("could not load camera frames. check your connection");
    return;
  }
  if (frames.length === 1) { showResult(frames, cam); return; }
  openClip(clipId);
}

/* browsers evict browser storage under pressure; say so before a long capture */
async function warnIfStorageTight() {
  try {
    const est = await navigator.storage.estimate();
    if (est.quota && est.quota - est.usage < 25e6) toast("storage is nearly full. old shots may be evicted", 3600);
  } catch (e) { /* not supported: carry on */ }
}

/* ---------- clip playback ---------- */
const clip = { frames: [], i: 0, fps: 8, timer: null, id: null };

function openClip(id) {
  const frames = framesOfClip(id);
  if (!frames.length) return;
  clip.frames = frames; clip.i = 0; clip.id = id;
  const cam = state.byId.get(frames[0].camId);
  $("clip-title").textContent = cam ? shortName(cam) : "clip";
  const scrub = $("clip-scrub");
  scrub.max = String(frames.length - 1);
  scrub.value = "0";
  syncClipFps();
  document.querySelector(".clip-stage").classList.remove("loaded");
  $("clip").hidden = false;
  showClipFrame(0);
  /* the frames are already in Cache Storage, but decode them all before playing
     so the first pass does not stutter */
  Promise.all(frames.map(f => new Promise(r => {
    const im = new Image();
    im.onload = im.onerror = () => r();
    im.src = shotSrc(f);
  }))).then(() => { if (!$("clip").hidden && clip.id === id) clipPlay(true); });
}

function showClipFrame(i) {
  const f = clip.frames[i];
  if (!f) return;
  clip.i = i;
  const img = $("clip-img");
  img.onload = () => document.querySelector(".clip-stage").classList.add("loaded");
  img.src = shotSrc(f);
  $("clip-scrub").value = String(i);
  $("clip-meta").textContent = `frame ${i + 1} / ${clip.frames.length} · ${fmtWhen(f.when)}`;
}

function syncClipFps() {
  for (const b of document.querySelectorAll(".clip-fps .chip")) {
    b.classList.toggle("on", Number(b.dataset.fps) === clip.fps);
  }
}

function clipPlay(on) {
  clearInterval(clip.timer);
  clip.timer = null;
  $("clip-play").textContent = on ? "pause" : "play";
  if (!on) return;
  clip.timer = setInterval(() => {
    showClipFrame((clip.i + 1) % clip.frames.length);   // loops
  }, 1000 / clip.fps);
}

function closeClip() {
  clipPlay(false);
  $("clip").hidden = true;
  clip.frames = []; clip.id = null;
}

/* ---------- result ---------- */
function closeResult(saved) {
  $("result").hidden = true;
  if (saved && !$("sheet").hidden) {
    toast("saved below in “your shots” ↓", 2800);
    pulseShots();
  }
}

function showResult(shotList, cam) {
  const grid = $("result-grid");
  grid.innerHTML = "";
  $("result-title").textContent = cam ? shortName(cam) : "your photo";
  for (const s of shotList) {
    const fig = document.createElement("figure");
    fig.className = "shot-fig";
    const im = document.createElement("img");
    im.src = s.sid ? shotSrc(s) : s.url;
    im.alt = `${cam ? cam.name : "camera"}. ${s.label}`;
    const cap = document.createElement("div");
    cap.className = "shot-label";
    const when = s.when instanceof Date ? s.when : new Date(s.when);
    cap.textContent = `${s.label} · ${when.toLocaleTimeString("et-EE")}`;
    fig.appendChild(im); fig.appendChild(cap);
    if (s.sid) {
      fig.appendChild(makeShotX(s.sid, false, () => {
        fig.remove();
        if (!grid.children.length) closeResult(false);
      }));
    }
    grid.appendChild(fig);
  }
  $("result").hidden = false;
}

/* ---------- geolocation ---------- */
/* far-away visitors get a one-time explainer instead of the map jumping to their city */
const AWAY_M = 40000;
const AWAY_KEY = "tcs-away-v1";

function userIsFar() {
  return !!state.user && haversine(state.user, TLL_CENTER) > AWAY_M;
}

/* first visit ever: one card saying what this is. localStorage, so it never
   comes back; if storage is blocked, skip rather than nag every visit */
const WELCOME_KEY = "tcs-welcome-v1";
function maybeShowWelcome() {
  try {
    if (localStorage.getItem(WELCOME_KEY)) return;
    localStorage.setItem(WELCOME_KEY, "1");
  } catch (e) { return; }
  $("welcome").hidden = false;
}

function maybeShowAway() {
  if (!userIsFar() || new URLSearchParams(location.search).get("cam")) return;
  if (!$("welcome").hidden) { state.awayPending = true; return; } // welcome goes first
  try {
    if (sessionStorage.getItem(AWAY_KEY)) return;
    sessionStorage.setItem(AWAY_KEY, "1");
  } catch { /* still show it, just maybe again next reload */ }
  $("away").hidden = false;
}

function onPosition(lat, lng, acc) {
  state.user = L.latLng(lat, lng);
  if (!state.userMarker) {
    const icon = L.divIcon({ className: "", html: '<div class="user-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
    state.userMarker = L.marker(state.user, { icon, zIndexOffset: 900 }).addTo(map);
    state.accCircle = L.circle(state.user, { radius: acc || 0, color: "#000087", weight: 1, opacity: .4, fillOpacity: .08 }).addTo(map);
    if (!userIsFar()) map.setView(state.user, 14);
    maybeShowAway();
  } else {
    state.userMarker.setLatLng(state.user);
    state.accCircle.setLatLng(state.user).setRadius(acc || 0);
  }
  updateDistance();
  updateLine();
  updateListDists();
  if (!$("favs").hidden) renderFavs(); // live distances and nearest-sort once located
}

function startLocating() {
  const fake = new URLSearchParams(location.search).get("at");
  if (fake) {
    const [la, ln] = fake.split(",").map(Number);
    if (isFinite(la) && isFinite(ln)) { onPosition(la, ln, 25); $("btn-locate").classList.add("on"); return; }
  }
  if (!("geolocation" in navigator)) { toast("geolocation is not available in this browser"); return; }
  if (!window.isSecureContext) { toast("location needs https (or localhost)"); return; }
  if (state.watching) {
    map.setView(state.user || map.getCenter(), 15); // explicit tap: go to the user even when far from tallinn
    return;
  }
  state.watching = true;
  $("btn-locate").classList.add("on");
  state.watchId = navigator.geolocation.watchPosition(
    (p) => onPosition(p.coords.latitude, p.coords.longitude, p.coords.accuracy),
    (err) => {
      state.watching = false;
      $("btn-locate").classList.remove("on");
      toast(err.code === 1 ? "location permission denied" : "could not get your location");
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
  );
}

/* ---------- boot ---------- */
async function boot() {
  try {
    const r = await fetch("data/cameras.json");
    const data = await r.json();
    state.cams = data.cams.filter(c => c.lat != null);
    state.byId = new Map(state.cams.map(c => [c.id, c]));
    const skipped = data.cams.length - state.cams.length;
    buildSpots();
    renderMarkers();
    try {
      localStorage.removeItem(VIEW_KEY); // old cross-visit pref
      if (sessionStorage.getItem(VIEW_KEY) === "list") setView("list");
    } catch { /* storage blocked */ }
    toast(`${state.cams.length} cameras on the map${skipped ? ` (${skipped} without a location)` : ""}`);
  } catch (e) {
    toast("could not load camera data");
    console.error(e);
  }
  updateNavCounts();
  maybeShowWelcome();
  maybeOfferA2hs();

  const camParam = new URLSearchParams(location.search).get("cam");
  startLocating();
  if (camParam) {
    const c = state.cams.find(x => x.id === camParam);
    if (c) selectSpot(state.spots.get(spotKey(c)), c.id);
  }
}

$("btn-locate").onclick = startLocating;
$("btn-about").onclick = () => { $("about").hidden = false; };
$("about-close").onclick = () => { $("about").hidden = true; };
$("sheet-close").onclick = closeSheet;
$("sheet").addEventListener("scroll", updateSheetShade, { passive: true });
window.addEventListener("resize", () => { if (!$("sheet").hidden) updateSheetShade(); });

/* ios home-screen app: rotating mid-scroll can scroll the document out from
   under overflow:hidden and leave the open scroller eating every touch.
   after a rotation, pin the document back and rebuild visible scrollers. */
function settleAfterRotate() {
  window.scrollTo(0, 0);
  for (const id of ["sheet", "clip", "result", "gallery", "favs", "about"]) {
    const el = $(id);
    if (el.hidden) continue;
    const top = el.scrollTop;
    el.style.overflowY = "hidden";
    void el.offsetHeight;
    el.style.overflowY = "";
    el.scrollTop = top;
  }
}
function onRotate() {
  settleAfterRotate();
  setTimeout(settleAfterRotate, 400); // ios settles the viewport late
}
window.addEventListener("orientationchange", onRotate);
if (screen.orientation) screen.orientation.addEventListener("change", onRotate);
$("btn-shot").onclick = photoNow;
$("btn-record").onclick = openRecorder;
$("rec-start").onclick = startRecording;
$("rec-cancel").onclick = () => {
  if (recPhase === "live") { if (recAbort) recAbort.stop = true; return; } // keeps what was captured
  if (recAbort) recAbort.stop = true;
  recPhase = "idle";
  $("recorder").hidden = true;
  keepAwake(false);
};
$("clip-close").onclick = closeClip;
$("clip-done").onclick = closeClip;
$("clip-play").onclick = () => clipPlay(!clip.timer);
$("clip-scrub").oninput = (e) => { clipPlay(false); showClipFrame(Number(e.target.value)); };
document.querySelectorAll(".clip-fps .chip").forEach(b => {
  b.onclick = () => {
    clip.fps = Number(b.dataset.fps);
    syncClipFps();
    if (clip.timer) clipPlay(true); // restart at the new rate
  };
});
$("clip-delete").onclick = () => confirmDeleteClip(clip.id, closeClip);
document.querySelectorAll("[data-count]").forEach(b =>
  b.onclick = () => countdownPhoto(parseInt(b.dataset.count, 10)));
$("countdown-cancel").onclick = () => {
  if (countdownAbort) countdownAbort.stop = true;
  $("countdown").hidden = true;
  keepAwake(false);
};
$("result-close").onclick = () => closeResult(true);
$("btn-done").onclick = () => closeResult(true);
$("btn-again").onclick = () => {
  $("result").hidden = true;
  if (state.lastCapture === "now") photoNow();
  else countdownPhoto(state.lastCapture);
};

/* phones: the native share sheet. the clipboard path only exists for
   browsers with no share API at all (mainly desktop chrome) */
$("btn-share").onclick = async () => {
  if (!state.sel) return;
  const cam = state.sel;
  const url = `${location.origin}${location.pathname}?cam=${cam.id}`;
  if (navigator.share) {
    try {
      await navigator.share({
        title: "tallinn traffic cam selfie",
        url,
      });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return; // user closed the share sheet
      /* anything else: fall through and copy instead */
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    shareTip();
  } catch (e) {
    if (legacyCopy(url)) shareTip();
    else toast(url, 6000); // last resort: show it so it can be copied by hand
  }
};

/* the copied confirmation, anchored under the share button */
function shareTip() {
  const el = $("share-tip");
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 2600);
}

/* clipboard for insecure contexts (e.g. testing over plain http on the lan) */
function legacyCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) { /* unsupported */ }
  ta.remove();
  return ok;
}

$("btn-fav").onclick = () => {
  if (!state.sel) return;
  toggleFav(state.sel.id);
  toast(isFav(state.sel.id) ? "saved to favorites" : "removed from favorites", 1800);
};
$("view-map").onclick = () => setView("map");
$("view-list").onclick = () => setView("list");
function closeWelcome() {
  $("welcome").hidden = true;
  if (state.awayPending) { state.awayPending = false; maybeShowAway(); }
}
$("welcome-continue").onclick = closeWelcome;
$("welcome").onclick = (e) => { if (e.target === $("welcome")) closeWelcome(); };
function closeAway() {
  $("away").hidden = true;
  map.setView(TLL_CENTER, TLL_ZOOM);
}
$("away-continue").onclick = closeAway;
$("away").onclick = (e) => { if (e.target === $("away")) closeAway(); };
$("nav-favs").onclick = () => { renderFavs(); $("favs").hidden = false; };
document.querySelectorAll("#favs-sort .chip").forEach(b => {
  b.onclick = () => setFavSort(b.dataset.sort);
});
$("favs-close").onclick = () => { $("favs").hidden = true; };
$("nav-gallery").onclick = () => { renderGallery(); $("gallery").hidden = false; };
$("gallery-close").onclick = () => { $("gallery").hidden = true; };

/* persist captured pixels across refreshes (see sw.js) */
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* optional */ });
}

boot();

/* debug hooks (harmless in production) */
window.dbg = { state, selectSpot, map, spotKey, refreshListFeeds };
window.addEventListener("error", (e) => { window.__lastErr = String(e.error || e.message); });
