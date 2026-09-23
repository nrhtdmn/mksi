import {
  distanceM,
  bearingMil,
  destination,
  arcPoints,
  fmtDist,
  fmtArea,
  circleArea,
  polygonArea,
  normMil,
  fmtCoord,
} from "./geo.js";
import {
  loadState,
  saveState,
  exportJson,
  parseImport,
  shareOrDownload,
} from "./storage.js";
import { getSlopeNear, getWeather } from "./weather.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let state = {
  points: [],
  drawings: [],
  shapes: [],
  settings: { layer: "hybrid", lastLat: 39.92, lastLon: 32.85, lastZoom: 12 },
};

let map, layers = {};
let gpsMarker = null;
let gpsAccuracy = null;
let lastGps = null; // {lat, lon, acc, alt, sats?}
let watchId = null;
let activeTool = null;
let pickMode = null; // 'circle' | 'arc' | 'savept' | 'measure1' ...
let tempLayer = L.layerGroup();
let savedLayer = L.layerGroup();
let measurePts = [];
let areaPts = [];
let drawLine = null;
let drawing = false;
let pendingShape = null;

function toast(msg, ms = 2200) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), ms);
}

function toMgrs(lat, lon) {
  try {
    if (typeof mgrs !== "undefined") return mgrs.forward([lon, lat], 5);
  } catch (_) {}
  return fmtCoord(lat, lon);
}

function setNetDot() {
  const d = $("#netDot");
  d.classList.toggle("online", navigator.onLine);
  d.classList.toggle("offline", !navigator.onLine);
}

function openSheet(id) {
  closeSheets();
  $("#backdrop").classList.add("open");
  $(id)?.classList.add("open");
}

function closeSheets() {
  $("#backdrop").classList.remove("open");
  $$(".sheet").forEach((s) => s.classList.remove("open"));
}

function setModeBanner(text) {
  const b = $("#modeBanner");
  if (!text) {
    b.classList.remove("show");
    b.textContent = "";
    return;
  }
  b.textContent = text;
  b.classList.add("show");
}

function resetMapInteractions() {
  map.dragging.enable();
  map.doubleClickZoom.enable();
  map.getContainer().classList.remove("draw-mode");
}

function setTool(name) {
  cancelPick();
  resetMapInteractions();
  activeTool = name;
  $$("#toolbar .btn").forEach((b) => b.classList.toggle("active", b.dataset.tool === name));
  map.getContainer().classList.toggle(
    "draw-mode",
    name === "draw" || name === "measure" || name === "bearing" || name === "area"
  );

  if (name === "circle") openSheet("#sheetCircle");
  else if (name === "arc") openSheet("#sheetArc");
  else if (name === "savept") openSheet("#sheetSavePt");
  else if (name === "measure") {
    measurePts = [];
    clearTemp();
    setModeBanner("1. noktaya dokun");
  } else if (name === "bearing") {
    measurePts = [];
    clearTemp();
    setModeBanner("Başlangıç noktasına dokun");
  } else if (name === "area") {
    areaPts = [];
    clearTemp();
    map.doubleClickZoom.disable();
    setModeBanner("Köşeleri işaretle — bitince «Alan✓»");
    toast("Alan: köşeleri işaretleyin");
  } else if (name === "draw") {
    map.dragging.disable();
    setModeBanner("Kalem: parmağınızla çizin");
  } else if (name === "finishArea") {
    if (areaPts.length < 3) {
      toast("En az 3 köşe gerekli");
      activeTool = "area";
      map.doubleClickZoom.disable();
      $$("#toolbar .btn").forEach((b) => b.classList.toggle("active", b.dataset.tool === "area"));
      setModeBanner("Köşeleri işaretle — bitince «Alan✓»");
      return;
    }
    finishArea();
    activeTool = null;
    $$("#toolbar .btn").forEach((b) => b.classList.remove("active"));
  } else if (name === "weather") {
    refreshWeatherAtFocus();
    activeTool = null;
    $$("#toolbar .btn").forEach((b) => b.classList.remove("active"));
  } else {
    setModeBanner("");
  }
}

function cancelPick() {
  pickMode = null;
  drawing = false;
  if (drawLine) {
    /* keep unfinished? discard */
  }
}

function clearTemp() {
  tempLayer.clearLayers();
  pendingShape = null;
}

function persist() {
  state.settings.lastLat = map.getCenter().lat;
  state.settings.lastLon = map.getCenter().lng;
  state.settings.lastZoom = map.getZoom();
  return saveState(state);
}

function initMap() {
  const s = state.settings;
  map = L.map("map", {
    zoomControl: true,
    attributionControl: true,
    maxZoom: 19,
  }).setView([s.lastLat, s.lastLon], s.lastZoom);

  layers.street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap",
  });

  layers.sat = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "© Esri" }
  );

  layers.labels = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, opacity: 0.85, attribution: "" }
  );

  layers.hybrid = L.layerGroup([layers.sat, layers.labels]);

  setBaseLayer(s.layer || "hybrid");
  tempLayer.addTo(map);
  savedLayer.addTo(map);

  map.on("moveend", () => {
    const c = map.getCenter();
    updateInfoFor(c.lat, c.lng, { fromMap: true });
    persist();
  });

  map.on("click", onMapClick);
  map.on("dblclick", onMapDblClick);

  const container = map.getContainer();
  container.addEventListener("pointerdown", onDrawStart, { passive: false });
  window.addEventListener("pointermove", onDrawMove, { passive: false });
  window.addEventListener("pointerup", onDrawEnd);
  window.addEventListener("pointercancel", onDrawEnd);

  renderSaved();
}

function setBaseLayer(name) {
  Object.values(layers).forEach((l) => {
    if (map.hasLayer(l) && (l === layers.street || l === layers.hybrid)) map.removeLayer(l);
  });
  if (name === "street") layers.street.addTo(map);
  else {
    layers.hybrid.addTo(map);
    name = "hybrid";
  }
  state.settings.layer = name;
  $$("#layerToggle button").forEach((b) => b.classList.toggle("active", b.dataset.layer === name));
  persist();
}

function onMapClick(e) {
  const { lat, lng: lon } = e.latlng;

  if (pickMode === "circle") {
    drawCircleAt(lat, lon);
    pickMode = null;
    setModeBanner("");
    return;
  }
  if (pickMode === "arc") {
    drawArcAt(lat, lon);
    pickMode = null;
    setModeBanner("");
    return;
  }
  if (pickMode === "savept") {
    savePointAt(lat, lon, $("#savePtName").value.trim() || "Nokta");
    pickMode = null;
    setModeBanner("");
    closeSheets();
    return;
  }

  if (activeTool === "measure" || activeTool === "bearing") {
    measurePts.push({ lat, lon });
    L.circleMarker([lat, lon], { radius: 6, color: "#e8b84a", fillColor: "#e8b84a", fillOpacity: 1 }).addTo(tempLayer);
    if (measurePts.length === 1) {
      setModeBanner("2. noktaya dokun");
    } else if (measurePts.length >= 2) {
      const a = measurePts[0];
      const b = measurePts[1];
      const dist = distanceM(a.lat, a.lon, b.lat, b.lon);
      const mil = bearingMil(a.lat, a.lon, b.lat, b.lon);
      L.polyline(
        [
          [a.lat, a.lon],
          [b.lat, b.lon],
        ],
        { color: "#3d9a6a", weight: 3 }
      ).addTo(tempLayer);
      const html =
        activeTool === "measure"
          ? `<strong>Mesafe:</strong> ${fmtDist(dist)}<br/><strong>İstikamet:</strong> ${mil} milyem<br/><strong>A→B:</strong> ${toMgrs(a.lat, a.lon)} → ${toMgrs(b.lat, b.lon)}`
          : `<strong>İstikamet açısı:</strong> ${mil} milyem<br/><strong>Mesafe:</strong> ${fmtDist(dist)}<br/><strong>Başlangıç:</strong> ${toMgrs(a.lat, a.lon)}<br/><strong>Bitiş:</strong> ${toMgrs(b.lat, b.lon)}`;
      pendingShape = {
        type: activeTool,
        pts: [a, b],
        dist,
        mil,
      };
      showResult(activeTool === "measure" ? "Mesafe" : "İstikamet", html);
      measurePts = [];
      setModeBanner("");
      activeTool = null;
      $$("#toolbar .btn").forEach((b) => b.classList.remove("active"));
    }
    return;
  }

  if (activeTool === "area") {
    areaPts.push({ lat, lon });
    L.circleMarker([lat, lon], { radius: 5, color: "#4a9fd4", fillOpacity: 1 }).addTo(tempLayer);
    if (areaPts.length >= 2) {
      tempLayer.eachLayer((l) => {
        if (l instanceof L.Polyline && !(l instanceof L.Polygon)) tempLayer.removeLayer(l);
      });
      L.polyline(
        areaPts.map((p) => [p.lat, p.lon]),
        { color: "#4a9fd4", weight: 2, dashArray: "4 4" }
      ).addTo(tempLayer);
    }
    setModeBanner(`${areaPts.length} köşe — bitirmek için çift dokun`);
    return;
  }

  updateInfoFor(lat, lon, { forceWeather: false });
}

function onMapDblClick(e) {
  if (activeTool !== "area" || areaPts.length < 3) return;
  L.DomEvent.stop(e);
  finishArea();
}

function finishArea() {
  if (areaPts.length < 3) {
    toast("En az 3 köşe gerekli");
    return;
  }
  const area = polygonArea(areaPts);
  L.polygon(
    areaPts.map((p) => [p.lat, p.lon]),
    { color: "#4a9fd4", weight: 2, fillOpacity: 0.2 }
  ).addTo(tempLayer);
  pendingShape = { type: "area", pts: [...areaPts], area };
  showResult("Alan", `<strong>Alan:</strong> ${fmtArea(area)}<br/><strong>Köşe:</strong> ${areaPts.length}`);
  areaPts = [];
  setModeBanner("");
  activeTool = null;
  $$("#toolbar .btn").forEach((b) => b.classList.remove("active"));
}

/* Freehand draw */
function eventToLatLng(e) {
  if (!map) return null;
  return map.mouseEventToLatLng(e);
}

function onDrawStart(e) {
  if (activeTool !== "draw") return;
  if (e.target.closest?.(".leaflet-control")) return;
  e.preventDefault();
  const ll = eventToLatLng(e);
  if (!ll) return;
  drawing = true;
  drawLine = L.polyline([[ll.lat, ll.lng]], { color: "#e8b84a", weight: 3 }).addTo(tempLayer);
}

function onDrawMove(e) {
  if (!drawing || !drawLine) return;
  e.preventDefault();
  const ll = eventToLatLng(e);
  if (!ll) return;
  drawLine.addLatLng([ll.lat, ll.lng]);
}

function onDrawEnd() {
  if (!drawing) return;
  drawing = false;
  if (drawLine) {
    const latlngs = drawLine.getLatLngs();
    pendingShape = {
      type: "draw",
      pts: latlngs.map((p) => ({ lat: p.lat, lon: p.lng })),
    };
    showResult("Çizim", `<strong>Nokta sayısı:</strong> ${latlngs.length}<br/>Kaydedebilir veya temizleyebilirsiniz.`);
  }
}

function showResult(title, html) {
  $("#resultTitle").textContent = title;
  $("#resultBody").innerHTML = html;
  openSheet("#sheetResult");
}

function drawCircleAt(lat, lon) {
  const r = Number($("#circleRadius").value) || 500;
  clearTemp();
  L.circle([lat, lon], { radius: r, color: "#3d9a6a", fillOpacity: 0.15, weight: 2 }).addTo(tempLayer);
  L.circleMarker([lat, lon], { radius: 5, color: "#e8b84a", fillOpacity: 1 }).addTo(tempLayer);
  const area = circleArea(r);
  const html = `<strong>Yarıçap:</strong> ${fmtDist(r)}<br/><strong>Alan:</strong> ${fmtArea(area)}<br/><strong>Merkez MGRS:</strong> ${toMgrs(lat, lon)}`;
  $("#circleResult").innerHTML = html;
  pendingShape = { type: "circle", center: { lat, lon }, radius: r, area };
  toast("Daire çizildi");
}

function drawArcAt(lat, lon) {
  const main = Number($("#arcBearing").value) || 0;
  const dist = Number($("#arcDist").value) || 1000;
  const right = Number($("#arcRight").value) || 0;
  const left = Number($("#arcLeft").value) || 0;
  clearTemp();
  const { pts, startMil, endMil, mainMil } = arcPoints(lat, lon, main, dist, left, right);
  const latlngs = pts.map((p) => [p.lat, p.lon]);
  L.polyline(latlngs, { color: "#e8b84a", weight: 3 }).addTo(tempLayer);
  // rays to flanks
  const leftPt = destination(lat, lon, startMil, dist);
  const rightPt = destination(lat, lon, endMil, dist);
  const midPt = destination(lat, lon, mainMil, dist);
  L.polyline(
    [
      [lat, lon],
      [midPt.lat, midPt.lon],
    ],
    { color: "#3d9a6a", weight: 2, dashArray: "6 4" }
  ).addTo(tempLayer);
  L.polyline(
    [
      [lat, lon],
      [leftPt.lat, leftPt.lon],
    ],
    { color: "#4a9fd4", weight: 1 }
  ).addTo(tempLayer);
  L.polyline(
    [
      [lat, lon],
      [rightPt.lat, rightPt.lon],
    ],
    { color: "#d64545", weight: 1 }
  ).addTo(tempLayer);
  L.circleMarker([lat, lon], { radius: 5, color: "#fff", fillOpacity: 1 }).addTo(tempLayer);

  const html =
    `<strong>İstikamet:</strong> ${mainMil} milyem<br/>` +
    `<strong>Mesafe:</strong> ${fmtDist(dist)}<br/>` +
    `<strong>Sağ yan hududu:</strong> ${right} <span style="color:#8a9bb0">(→ ${endMil})</span><br/>` +
    `<strong>Sol yan hududu:</strong> ${left} <span style="color:#8a9bb0">(→ ${startMil})</span><br/>` +
    `<strong>Merkez:</strong> ${toMgrs(lat, lon)}`;
  $("#arcResult").innerHTML = html;
  pendingShape = {
    type: "arc",
    center: { lat, lon },
    mainMil,
    dist,
    right,
    left,
    startMil,
    endMil,
    pts,
  };
  toast("Kavis çizildi");
}

function savePointAt(lat, lon, name) {
  const pt = {
    id: crypto.randomUUID?.() || String(Date.now()),
    name: name || "Nokta",
    lat,
    lon,
    mgrs: toMgrs(lat, lon),
    createdAt: new Date().toISOString(),
  };
  state.points.push(pt);
  persist();
  renderSaved();
  toast(`Kaydedildi: ${pt.name}`);
}

function renderSaved() {
  savedLayer.clearLayers();
  for (const p of state.points) {
    const m = L.circleMarker([p.lat, p.lon], {
      radius: 7,
      color: "#e8b84a",
      fillColor: "#1a2332",
      fillOpacity: 1,
      weight: 3,
    }).addTo(savedLayer);
    m.bindPopup(`<b>${escapeHtml(p.name)}</b><br/>${p.mgrs || toMgrs(p.lat, p.lon)}`);
  }
  for (const sh of state.shapes) {
    addShapeToLayer(sh, savedLayer);
  }
  for (const d of state.drawings) {
    if (d.pts?.length) {
      L.polyline(
        d.pts.map((p) => [p.lat, p.lon]),
        { color: d.color || "#e8b84a", weight: 3, opacity: 0.85 }
      ).addTo(savedLayer);
    }
  }
  renderLists();
}

function addShapeToLayer(sh, layer) {
  if (sh.type === "circle" && sh.center) {
    L.circle([sh.center.lat, sh.center.lon], {
      radius: sh.radius,
      color: "#3d9a6a",
      fillOpacity: 0.12,
      weight: 2,
    }).addTo(layer);
  } else if (sh.type === "arc" && sh.pts) {
    L.polyline(
      sh.pts.map((p) => [p.lat, p.lon]),
      { color: "#e8b84a", weight: 3 }
    ).addTo(layer);
  } else if ((sh.type === "measure" || sh.type === "bearing") && sh.pts?.length === 2) {
    L.polyline(
      [
        [sh.pts[0].lat, sh.pts[0].lon],
        [sh.pts[1].lat, sh.pts[1].lon],
      ],
      { color: "#3d9a6a", weight: 2 }
    ).addTo(layer);
  } else if (sh.type === "area" && sh.pts) {
    L.polygon(
      sh.pts.map((p) => [p.lat, p.lon]),
      { color: "#4a9fd4", weight: 2, fillOpacity: 0.15 }
    ).addTo(layer);
  } else if (sh.type === "draw" && sh.pts) {
    L.polyline(
      sh.pts.map((p) => [p.lat, p.lon]),
      { color: "#e8b84a", weight: 3 }
    ).addTo(layer);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderLists() {
  const pl = $("#pointsList");
  pl.innerHTML = state.points.length
    ? state.points
        .map(
          (p) => `<li>
        <div class="meta"><div class="name">${escapeHtml(p.name)}</div><div class="sub">${escapeHtml(p.mgrs || "")}</div></div>
        <button type="button" class="btn icon" data-goto="${p.id}">➤</button>
        <button type="button" class="btn icon danger" data-del-pt="${p.id}">🗑</button>
      </li>`
        )
        .join("")
    : `<li><div class="meta"><div class="sub">Kayıtlı nokta yok</div></div></li>`;

  const sl = $("#shapesList");
  sl.innerHTML = state.shapes.length
    ? state.shapes
        .map(
          (s, i) => `<li>
        <div class="meta"><div class="name">${escapeHtml(s.label || s.type)}</div><div class="sub">${escapeHtml(s.summary || "")}</div></div>
        <button type="button" class="btn icon danger" data-del-sh="${i}">🗑</button>
      </li>`
        )
        .join("")
    : `<li><div class="meta"><div class="sub">Kayıtlı şekil yok</div></div></li>`;
}

async function updateInfoFor(lat, lon, opts = {}) {
  $("#infoMgrs").textContent = toMgrs(lat, lon);
  if (lastGps && !opts.fromMap) {
    $("#infoAcc").textContent = lastGps.acc != null ? `±${Math.round(lastGps.acc)} m` : "—";
  } else if (opts.fromMap && lastGps) {
    /* keep gps accuracy when panning */
  }

  if (!navigator.onLine) {
    $("#infoElev").textContent = "çevrimdışı";
    $("#infoSlope").textContent = "—";
    if (opts.forceWeather) $("#infoWeather").textContent = "çevrimdışı";
    return;
  }

  try {
    const { elev, slope } = await getSlopeNear(lat, lon);
    if (elev != null) $("#infoElev").textContent = `${Math.round(elev)} m`;
    else $("#infoElev").textContent = "—";
    if (slope != null) $("#infoSlope").textContent = `%${slope.toFixed(1)}`;
    else $("#infoSlope").textContent = "—";
  } catch {
    /* ignore */
  }

  if (opts.forceWeather !== false) {
    /* only auto-refresh weather on locate / weather button to save API */
  }
}

async function refreshWeatherAtFocus() {
  const c = lastGps || { lat: map.getCenter().lat, lon: map.getCenter().lng };
  const lat = c.lat;
  const lon = c.lon ?? c.lng;
  toast("Hava alınıyor…");
  const w = await getWeather(lat, lon);
  if (!w) {
    $("#infoWeather").textContent = navigator.onLine ? "alınamadı" : "çevrimdışı";
    toast("Hava durumu alınamadı");
    return;
  }
  $("#infoWeather").textContent = `${w.desc}, ${w.temp}°C, nem %${w.humidity}, rüzgar ${w.wind} m/s`;
  toast("Hava güncellendi");
}

function startGps() {
  if (!navigator.geolocation) {
    toast("Konum desteklenmiyor");
    return;
  }
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude: lat, longitude: lon, accuracy: acc, altitude: alt } = pos.coords;
      lastGps = { lat, lon, acc, alt };
      // Satellite count is not in standard Geolocation API
      const satHint = pos.coords.altitudeAccuracy != null ? "GPS/GNSS" : "Konum";
      $("#infoAcc").textContent =
        acc != null ? `±${Math.round(acc)} m (${satHint})` : "—";
      if (alt != null) $("#infoElev").textContent = `${Math.round(alt)} m (GPS)`;

      if (!gpsMarker) {
        gpsMarker = L.circleMarker([lat, lon], {
          radius: 8,
          color: "#fff",
          fillColor: "#4a9fd4",
          fillOpacity: 1,
          weight: 2,
        }).addTo(map);
        gpsAccuracy = L.circle([lat, lon], {
          radius: acc || 20,
          color: "#4a9fd4",
          fillOpacity: 0.08,
          weight: 1,
        }).addTo(map);
      } else {
        gpsMarker.setLatLng([lat, lon]);
        gpsAccuracy.setLatLng([lat, lon]);
        gpsAccuracy.setRadius(acc || 20);
      }
      $("#infoMgrs").textContent = toMgrs(lat, lon);
    },
    (err) => toast("Konum: " + (err.message || "hata")),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
}

function goToLocation() {
  if (!lastGps) {
    toast("Konum bekleniyor…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lon, accuracy: acc, altitude: alt } = pos.coords;
        lastGps = { lat, lon, acc, alt };
        map.setView([lat, lon], Math.max(map.getZoom(), 15));
        updateInfoFor(lat, lon);
        getSlopeNear(lat, lon).then(({ elev, slope }) => {
          if (elev != null && alt == null) $("#infoElev").textContent = `${Math.round(elev)} m`;
          if (slope != null) $("#infoSlope").textContent = `%${slope.toFixed(1)}`;
        });
        refreshWeatherAtFocus();
      },
      () => toast("Konum alınamadı"),
      { enableHighAccuracy: true, timeout: 12000 }
    );
    return;
  }
  map.setView([lastGps.lat, lastGps.lon], Math.max(map.getZoom(), 15));
  updateInfoFor(lastGps.lat, lastGps.lon);
  refreshWeatherAtFocus();
}

function bindUi() {
  $("#btnLocate").addEventListener("click", goToLocation);
  $("#btnMenu").addEventListener("click", () => {
    renderLists();
    openSheet("#sheetMenu");
  });
  $("#backdrop").addEventListener("click", closeSheets);
  $$(".close-sheet").forEach((b) => b.addEventListener("click", closeSheets));

  $$("#layerToggle button").forEach((b) =>
    b.addEventListener("click", () => setBaseLayer(b.dataset.layer))
  );

  $$("#toolbar .btn").forEach((b) =>
    b.addEventListener("click", () => {
      const t = b.dataset.tool;
      if (t === "finishArea") {
        setTool("finishArea");
        return;
      }
      if (activeTool === t && t !== "weather") {
        setTool(null);
        clearTemp();
        setModeBanner("");
        $$("#toolbar .btn").forEach((x) => x.classList.remove("active"));
        return;
      }
      setTool(t);
    })
  );

  $("#btnCircleDraw").addEventListener("click", () => {
    const mode = $("#circleCenter").value;
    if (mode === "gps") {
      if (!lastGps) return toast("Konum yok");
      drawCircleAt(lastGps.lat, lastGps.lon);
    } else {
      pickMode = "circle";
      closeSheets();
      setModeBanner("Daire merkezi için dokun");
    }
  });
  $("#btnCircleClear").addEventListener("click", () => {
    clearTemp();
    $("#circleResult").innerHTML = "";
  });

  $("#btnArcDraw").addEventListener("click", () => {
    const mode = $("#arcCenter").value;
    if (mode === "gps") {
      if (!lastGps) return toast("Konum yok");
      drawArcAt(lastGps.lat, lastGps.lon);
    } else {
      pickMode = "arc";
      closeSheets();
      setModeBanner("Kavis merkezi için dokun");
    }
  });
  $("#btnArcClear").addEventListener("click", () => {
    clearTemp();
    $("#arcResult").innerHTML = "";
  });

  $("#btnSavePtGo").addEventListener("click", () => {
    const src = $("#savePtSrc").value;
    const name = $("#savePtName").value.trim() || "Nokta";
    if (src === "gps") {
      if (!lastGps) return toast("Konum yok");
      savePointAt(lastGps.lat, lastGps.lon, name);
      closeSheets();
    } else if (src === "cross") {
      const c = map.getCenter();
      savePointAt(c.lat, c.lng, name);
      closeSheets();
    } else {
      pickMode = "savept";
      closeSheets();
      setModeBanner("Kaydedilecek noktaya dokun");
    }
  });

  $("#btnResultClear").addEventListener("click", () => {
    clearTemp();
    closeSheets();
  });

  $("#btnResultSave").addEventListener("click", () => {
    if (!pendingShape) return toast("Kayıt yok");
    const sh = { ...pendingShape, id: String(Date.now()), savedAt: new Date().toISOString() };
    if (sh.type === "circle") {
      sh.label = "Daire";
      sh.summary = `r=${sh.radius}m · ${fmtArea(sh.area)}`;
      state.shapes.push(sh);
    } else if (sh.type === "arc") {
      sh.label = "Kavis";
      sh.summary = `${sh.mainMil} / R${sh.right} S${sh.left} · ${sh.dist}m`;
      state.shapes.push(sh);
    } else if (sh.type === "draw") {
      sh.label = "Çizim";
      state.drawings.push(sh);
    } else if (sh.type === "area") {
      sh.label = "Alan";
      sh.summary = fmtArea(sh.area);
      state.shapes.push(sh);
    } else {
      sh.label = sh.type === "bearing" ? "İstikamet" : "Mesafe";
      sh.summary = `${fmtDist(sh.dist)} · ${sh.mil} milyem`;
      state.shapes.push(sh);
    }
    persist();
    renderSaved();
    clearTemp();
    closeSheets();
    toast("Kaydedildi");
  });

  $("#btnExportAll").addEventListener("click", async () => {
    const text = exportJson(state, "all");
    const r = await shareOrDownload(`mksi-${dateStamp()}.json`, text);
    if (r !== "abort") toast(r === "download" ? "Dosya indirildi" : "Paylaşım açıldı");
  });
  $("#btnExportPts").addEventListener("click", async () => {
    const text = exportJson(state, "points");
    const r = await shareOrDownload(`mksi-noktalar-${dateStamp()}.json`, text);
    if (r !== "abort") toast(r === "download" ? "Dosya indirildi" : "Paylaşım açıldı");
  });
  $("#btnImport").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = parseImport(text);
      if (data.points.length) state.points = mergeById(state.points, data.points);
      if (data.shapes.length) state.shapes = state.shapes.concat(data.shapes);
      if (data.drawings.length) state.drawings = state.drawings.concat(data.drawings);
      await persist();
      renderSaved();
      toast("İçe aktarıldı");
      renderLists();
    } catch (e) {
      toast("Aktarım hatası: " + e.message);
    }
    ev.target.value = "";
  });

  $("#btnClearAll").addEventListener("click", async () => {
    if (!confirm("Tüm noktalar, şekiller ve çizimler silinsin mi?")) return;
    state.points = [];
    state.shapes = [];
    state.drawings = [];
    await persist();
    renderSaved();
    clearTemp();
    toast("Temizlendi");
  });

  $("#pointsList").addEventListener("click", (e) => {
    const go = e.target.closest("[data-goto]");
    const del = e.target.closest("[data-del-pt]");
    if (go) {
      const p = state.points.find((x) => x.id === go.dataset.goto);
      if (p) {
        map.setView([p.lat, p.lon], 16);
        closeSheets();
      }
    }
    if (del) {
      state.points = state.points.filter((x) => x.id !== del.dataset.delPt);
      persist();
      renderSaved();
    }
  });

  $("#shapesList").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del-sh]");
    if (del) {
      state.shapes.splice(Number(del.dataset.delSh), 1);
      persist();
      renderSaved();
    }
  });

  window.addEventListener("online", setNetDot);
  window.addEventListener("offline", setNetDot);
  setNetDot();
}

function mergeById(a, b) {
  const map = new Map(a.map((x) => [x.id, x]));
  for (const x of b) map.set(x.id || String(Math.random()), x);
  return [...map.values()];
}

function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
}

async function registerSw() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (_) {}
}

async function boot() {
  state = await loadState();
  initMap();
  bindUi();
  startGps();
  registerSw();
  const c = map.getCenter();
  updateInfoFor(c.lat, c.lng, { fromMap: true, forceWeather: false });
}

boot();
