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
  cams: [], spots: new Map(), markers: new Map(),
  sel: null, selSpot: null,
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
const map = L.map("map", { zoomControl: false, attributionControl: true })
  .setView([59.437, 24.754], 12);
L.control.zoom({ position: "bottomright" }).addTo(map);

/* Stamen Toner (hosted by Stadia Maps), recolored black -> Visit Estonia blue
   by the #ve-duotone SVG filter. Falls back to plain OSM if toner tiles fail
   (e.g. the domain is not registered with Stadia, or an outage). */
const CAMS_CREDIT = ' · cams: <a href="' + SITE + '">City of Tallinn</a>';
function addOsmFallback() {
  document.body.classList.remove("tile-toner");
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' + CAMS_CREDIT,
  }).addTo(map);
}
(function addToner() {
  document.body.classList.add("tile-toner");
  const key = (window.APP_CONFIG && window.APP_CONFIG.stadiaApiKey) || "";
  const tonerUrl = "https://tiles.stadiamaps.com/tiles/stamen_toner/{z}/{x}/{y}.png" +
    (key ? "?api_key=" + encodeURIComponent(key) : "");
  const toner = L.tileLayer(tonerUrl, {
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
    radius: on ? 10 : 7,
    color: "#fff", weight: 2, fillOpacity: 1,
    fillColor: on ? "#000087" : "#111",
  };
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

function renderMarkers() {
  for (const m of state.markers.values()) m.remove();
  state.markers.clear();
  for (const spot of state.spots.values()) {
    const on = state.selSpot === spot.key;
    const m = L.circleMarker([spot.lat, spot.lng], markerStyle(on))
      .addTo(map)
      .bindTooltip(shortName(spot.cams[0]), { className: "cam-tip", direction: "top", offset: [0, -8] })
      .on("click", () => selectSpot(spot));
    state.markers.set(spot.key, m);
  }
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
  if (state.user) {
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
function startPreview(cam) {
  stopPreview();
  const img = $("preview-img");
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
  if (!$("favs").hidden) renderFavs();
}

function renderFavs() {
  const list = $("favs-list");
  list.innerHTML = "";
  const cams = favs.map(id => state.cams.find(c => c.id === id)).filter(Boolean);
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
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `Open ${shortName(cam)}`);

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
    if (state.user) {
      const d = document.createElement("span");
      d.className = "fav-dist";
      d.textContent = `${fmtDist(haversine(state.user, cam))} ${compass(bearing(state.user, cam))}`;
      meta.appendChild(d);
    }
    main.appendChild(name);
    main.appendChild(meta);

    const rm = document.createElement("button");
    rm.className = "fav-remove";
    rm.title = "Remove from favorites";
    rm.setAttribute("aria-label", "Remove from favorites");
    rm.innerHTML = '<svg class="ico" width="20" height="20" aria-hidden="true"><use href="#i-star"/></svg>';
    rm.onclick = (e) => { e.stopPropagation(); toggleFav(cam.id); };

    const go = () => {
      $("favs").hidden = true;
      selectSpot(state.spots.get(spotKey(cam)), cam.id);
    };
    row.onclick = go;
    row.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };

    row.appendChild(main);
    row.appendChild(rm);
    list.appendChild(row);
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

function shotSrc(s) {
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

function askConfirm() {
  return new Promise((resolve) => {
    const box = $("confirm");
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

async function addShot(url, cam, label) {
  const sid = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  sessionUrls.set(sid, url);
  const shot = { sid, camId: cam.id, label, when: new Date().toISOString(), stored: false };
  shot.stored = await persistShot(sid, url);
  shots.unshift(shot);
  saveShots(shots);
  renderShots();
  updateNavCounts();
  return shot;
}

function makeShotX(sid, small, after) {
  const x = document.createElement("button");
  x.className = "shot-x" + (small ? " shot-x-sm" : "");
  x.setAttribute("aria-label", "Delete photo");
  x.textContent = "×";
  x.onclick = (e) => { e.stopPropagation(); confirmDelete(sid, after); };
  return x;
}

/* one side-scrolling strip of thumbnails; used by the sheet and the gallery */
function fillStrip(strip, list, withWhen) {
  for (const s of list) {
    const wrap = document.createElement("div");
    wrap.className = "shot-thumb";
    const im = document.createElement("img");
    im.src = shotSrc(s); im.alt = s.label;
    im.onclick = () => {
      const cam = state.cams.find(c => c.id === s.camId) || state.sel;
      showResult([s], cam);
    };
    im.onerror = () => { wrap.remove(); };
    wrap.appendChild(im);
    wrap.appendChild(makeShotX(s.sid, true));
    if (withWhen) {
      const t = document.createElement("div");
      t.className = "shot-when";
      t.textContent = fmtWhen(s.when);
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
  fillStrip(strip, mine.slice(0, 20), false);
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

    const meta = document.createElement("div");
    meta.className = "gal-meta";
    meta.textContent = `${list.length} ${list.length === 1 ? "photo" : "photos"}`;

    const strip = document.createElement("div");
    strip.className = "shots-strip";
    fillStrip(strip, list, true);

    sec.appendChild(h);
    sec.appendChild(meta);
    sec.appendChild(strip);
    body.appendChild(sec);
  }
}

/* ---------- nav counts ---------- */
function updateNavCounts() {
  const g = $("count-gallery"), f = $("count-favs");
  g.hidden = shots.length === 0;
  g.textContent = shots.length;
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

  /* burst: the cams refresh every few seconds — grab 3 frames to be safe */
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
function onPosition(lat, lng, acc) {
  state.user = L.latLng(lat, lng);
  if (!state.userMarker) {
    const icon = L.divIcon({ className: "", html: '<div class="user-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
    state.userMarker = L.marker(state.user, { icon, zIndexOffset: 900 }).addTo(map);
    state.accCircle = L.circle(state.user, { radius: acc || 0, color: "#000087", weight: 1, opacity: .4, fillOpacity: .08 }).addTo(map);
    map.setView(state.user, 14);
  } else {
    state.userMarker.setLatLng(state.user);
    state.accCircle.setLatLng(state.user).setRadius(acc || 0);
  }
  updateDistance();
  updateLine();
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
    map.setView(state.user || map.getCenter(), 15);
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
    const skipped = data.cams.length - state.cams.length;
    buildSpots();
    renderMarkers();
    toast(`${state.cams.length} cameras on the map${skipped ? ` (${skipped} without a location)` : ""}`);
  } catch (e) {
    toast("could not load camera data");
    console.error(e);
  }
  updateNavCounts();
  startLocating();

  const camParam = new URLSearchParams(location.search).get("cam");
  if (camParam) {
    const c = state.cams.find(x => x.id === camParam);
    if (c) selectSpot(state.spots.get(spotKey(c)), c.id);
  }
}

$("btn-locate").onclick = startLocating;
$("btn-about").onclick = () => { $("about").hidden = false; };
$("about-close").onclick = () => { $("about").hidden = true; };
$("sheet-close").onclick = closeSheet;
$("btn-shot").onclick = photoNow;
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

$("btn-fav").onclick = () => {
  if (!state.sel) return;
  toggleFav(state.sel.id);
  toast(isFav(state.sel.id) ? "saved to favorites" : "removed from favorites", 1800);
};
$("nav-favs").onclick = () => { renderFavs(); $("favs").hidden = false; };
$("favs-close").onclick = () => { $("favs").hidden = true; };
$("nav-gallery").onclick = () => { renderGallery(); $("gallery").hidden = false; };
$("gallery-close").onclick = () => { $("gallery").hidden = true; };

/* persist captured pixels across refreshes (see sw.js) */
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* optional */ });
}

boot();

/* debug hooks (harmless in production) */
window.dbg = { state, selectSpot, map, spotKey };
window.addEventListener("error", (e) => { window.__lastErr = String(e.error || e.message); });
