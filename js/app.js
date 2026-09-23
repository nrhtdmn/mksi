import {
  distanceM,
  bearingMil,
  destination,
  arcPoints,
  fmtDist,
  fmtArea,
  circleArea,
  polygonArea,
} from "./geo.js";
import {
  loadState,
  saveState,
  exportJson,
  parseImport,
  shareOrDownload,
} from "./storage.js";
import { getSlopeNear, getWeather } from "./weather.js";
import {
  fetchIller,
  fetchIlceler,
  fetchMahalleler,
  fetchParselByCoord,
  fetchParselByAda,
  ringToLatLngs,
  featureCenter,
  summarizeParsel,
  TKGM_SITE,
} from "./parsel.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let state = {
  points: [],
  drawings: [],
  shapes: [],
  settings: { layer: "hybrid", lastLat: 39.92, lastLon: 32.85, lastZoom: 12, chromeHidden: false },
};

let map;
let layers = {};
let gpsMarker = null;
let gpsAccuracy = null;
let lastGps = null;
let lastFocus = { lat: 39.92, lon: 32.85 };
let activeTool = null;
let pickMode = null; // circle | arc | savept | measure1 | measure2
let measureKind = "measure";
let tempLayer;
let savedLayer;
let measurePts = [];
let areaPts = [];
let drawLine = null;
let drawing = false;
let drawPointers = new Set();
let drawMultiTouch = false;
let drawStrokes = [];
let pendingShape = null;
let nameCallback = null;

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
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

function fromMgrs(str) {
  const s = String(str || "").trim();
  if (!s) throw new Error("MGRS boş");
  const compact = s.replace(/\s/g, "");
  const [lon, lat] = mgrs.toPoint(compact);
  return { lat, lon };
}

function uid() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  if (!map) return;
  map.dragging.enable();
  map.doubleClickZoom.enable();
  map.getContainer().classList.remove("draw-mode");
}

function clearToolHighlight() {
  $$("#toolbar .btn").forEach((b) => b.classList.remove("active"));
}

function highlightTool(name) {
  $$("#toolbar .btn").forEach((b) => b.classList.toggle("active", b.dataset.tool === name));
}

function fillPointSelects() {
  const opts =
    state.points.length === 0
      ? `<option value="">— kayıtlı nokta yok —</option>`
      : state.points
          .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
          .join("");
  ["#measureFrom", "#measureTo", "#circleSavedPt", "#arcSavedPt"].forEach((sel) => {
    const el = $(sel);
    if (el) el.innerHTML = opts;
  });
}

function getPointById(id) {
  return state.points.find((p) => p.id === id) || null;
}

function exitDrawMode(clearStrokes = true) {
  if (clearStrokes) drawStrokes = [];
  discardCurrentStroke();
  drawPointers.clear();
  drawMultiTouch = false;
  $("#drawBar").hidden = true;
  resetMapInteractions();
}

function setTool(name) {
  const leavingDraw = activeTool === "draw" && name !== "draw";
  if (leavingDraw) exitDrawMode(true);

  cancelPick();
  if (name !== "area" && name !== "finishArea") {
    areaPts = [];
  }
  if (name !== "draw") resetMapInteractions();

  activeTool = name;
  highlightTool(name);

  if (name === "measure" || name === "bearing") {
    measureKind = name;
    $("#measureSheetTitle").textContent = name === "measure" ? "Mesafe" : "İstikamet";
    fillPointSelects();
    $("#measureMode").value = "map";
    $("#measureSavedFields").classList.add("hidden");
    $("#measureName").value = "";
    openSheet("#sheetMeasure");
  } else if (name === "circle") {
    fillPointSelects();
    syncCircleCenterUi();
    openSheet("#sheetCircle");
  } else if (name === "arc") {
    fillPointSelects();
    syncArcCenterUi();
    openSheet("#sheetArc");
  } else if (name === "savept") {
    syncSavePtUi();
    openSheet("#sheetSavePt");
  } else if (name === "parsel") {
    openSheet("#sheetParsel");
    syncParselModeUi();
    ensureIllerLoaded();
  } else if (name === "area") {
    areaPts = [];
    clearTemp();
    map.doubleClickZoom.disable();
    setModeBanner("Köşeleri işaretle — Bitir ile tamamla");
    toast("Alan: köşeleri işaretleyin");
  } else if (name === "finishArea") {
    finishArea();
  } else if (name === "draw") {
    map.dragging.disable();
    map.getContainer().classList.add("draw-mode");
    $("#drawBar").hidden = false;
    setModeBanner("Kalem: tek parmak çiz, iki parmak gez");
    toast("Tek parmak: çiz · İki parmak: haritada gez");
  } else if (name === "weather") {
    refreshWeather();
    activeTool = null;
    clearToolHighlight();
    setModeBanner("");
  } else {
    setModeBanner("");
    $("#drawBar").hidden = true;
  }
}

function cancelPick() {
  pickMode = null;
  drawing = false;
  measurePts = [];
}

function clearTemp() {
  tempLayer.clearLayers();
  pendingShape = null;
}

function persist() {
  if (map) {
    const c = map.getCenter();
    state.settings.lastLat = c.lat;
    state.settings.lastLon = c.lng;
    state.settings.lastZoom = map.getZoom();
  }
  return saveState(state);
}

function askName(defaultName, cb) {
  nameCallback = cb;
  $("#nameInput").value = defaultName || "";
  openSheet("#sheetName");
  setTimeout(() => $("#nameInput").focus(), 200);
}

function addMapLabel(layer, lat, lon, html, multi = false) {
  const icon = L.divIcon({
    className: "map-label-icon",
    html: `<div class="map-label${multi ? " multi" : ""}">${html}</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
  return L.marker([lat, lon], { icon, interactive: false, keyboard: false }).addTo(layer);
}

function mid(a, b) {
  return { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
}

function centroid(pts) {
  let lat = 0;
  let lon = 0;
  for (const p of pts) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: lat / pts.length, lon: lon / pts.length };
}

function labelLine(layer, a, b, dist, mil, name) {
  const m = mid(a, b);
  const nameHtml = name
    ? `<span class="name">${escapeHtml(name)}</span>`
    : "";
  addMapLabel(
    layer,
    m.lat,
    m.lon,
    `${nameHtml}Mesafe: <span class="hl">${fmtDist(dist)}</span><br/>İstikamet: <span class="hl">${mil}</span> milyem`,
    true
  );
}

function labelCircleShape(layer, lat, lon, radius, name) {
  const edge = destination(lat, lon, 1600, radius);
  const nameHtml = name
    ? `<span class="name">${escapeHtml(name)}</span>`
    : "";
  addMapLabel(
    layer,
    edge.lat,
    edge.lon,
    `${nameHtml}Yarıçap: <span class="hl">${fmtDist(radius)}</span><br/>Alan: <span class="hl">${fmtArea(circleArea(radius))}</span>`,
    true
  );
}

function labelArcShape(layer, lat, lon, mainMil, dist, left, right, startMil, endMil, name) {
  const midPt = destination(lat, lon, mainMil, dist);
  const leftPt = destination(lat, lon, startMil, dist);
  const rightPt = destination(lat, lon, endMil, dist);
  const midRay = mid({ lat, lon }, midPt);
  const nameHtml = name
    ? `<span class="name">${escapeHtml(name)}</span>`
    : "";
  addMapLabel(
    layer,
    midRay.lat,
    midRay.lon,
    `${nameHtml}İstikamet: <span class="hl">${mainMil}</span> milyem<br/>Mesafe: <span class="hl">${fmtDist(dist)}</span>`,
    true
  );
  addMapLabel(
    layer,
    leftPt.lat,
    leftPt.lon,
    `Sol yan: <span class="hl">${left}</span>`,
    false
  );
  addMapLabel(
    layer,
    rightPt.lat,
    rightPt.lon,
    `Sağ yan: <span class="hl">${right}</span>`,
    false
  );
}

function labelAreaShape(layer, pts, area, name) {
  const c = centroid(pts);
  const nameHtml = name
    ? `<span class="name">${escapeHtml(name)}</span>`
    : "";
  addMapLabel(
    layer,
    c.lat,
    c.lon,
    `${nameHtml}Alan: <span class="hl">${fmtArea(area)}</span>`,
    true
  );
}

function showResult(title, html, suggestedName) {
  $("#resultTitle").textContent = title;
  $("#resultBody").innerHTML = html;
  $("#resultName").value = suggestedName || "";
  openSheet("#sheetResult");
}

function initMap() {
  const s = state.settings;
  tempLayer = L.layerGroup();
  savedLayer = L.layerGroup();

  map = L.map("map", { zoomControl: true, maxZoom: 19 }).setView(
    [s.lastLat ?? 39.92, s.lastLon ?? 32.85],
    s.lastZoom ?? 12
  );

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
    { maxZoom: 19, opacity: 0.85 }
  );
  layers.hybrid = L.layerGroup([layers.sat, layers.labels]);

  setBaseLayer(s.layer || "hybrid");
  tempLayer.addTo(map);
  savedLayer.addTo(map);

  map.on("moveend", () => {
    const c = map.getCenter();
    updateInfo(c.lat, c.lng, { fromMap: true });
    persist();
  });
  map.on("click", onMapClick);
  map.on("dblclick", (e) => {
    if (activeTool === "area" && areaPts.length >= 3) {
      L.DomEvent.stop(e);
      finishArea();
    }
  });

  const container = map.getContainer();
  container.addEventListener("pointerdown", onDrawStart, { passive: false });
  window.addEventListener("pointermove", onDrawMove, { passive: false });
  window.addEventListener("pointerup", onDrawPointerUp);
  window.addEventListener("pointercancel", onDrawPointerUp);

  renderSaved();
}

function setBaseLayer(name) {
  if (map.hasLayer(layers.street)) map.removeLayer(layers.street);
  if (map.hasLayer(layers.hybrid)) map.removeLayer(layers.hybrid);
  if (name === "street") {
    layers.street.addTo(map);
  } else {
    layers.hybrid.addTo(map);
    name = "hybrid";
  }
  state.settings.layer = name;
  $$("#layerToggle button").forEach((b) =>
    b.classList.toggle("active", b.dataset.layer === name)
  );
  persist();
}

function onMapClick(e) {
  if (activeTool === "draw") return;

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
    const name = $("#savePtName").value.trim() || "Nokta";
    savePointAt(lat, lon, name);
    pickMode = null;
    setModeBanner("");
    closeSheets();
    return;
  }
  if (pickMode === "parsel") {
    pickMode = null;
    setModeBanner("");
    queryParselAt(lat, lon);
    return;
  }
  if (pickMode === "measure1") {
    measurePts = [{ lat, lon }];
    L.circleMarker([lat, lon], { radius: 6, color: "#e8b84a", fillOpacity: 1 }).addTo(tempLayer);
    pickMode = "measure2";
    setModeBanner("2. noktaya dokun");
    return;
  }
  if (pickMode === "measure2") {
    const a = measurePts[0];
    pickMode = null;
    finishMeasureLine(a, { lat, lon });
    return;
  }

  if (activeTool === "area") {
    areaPts.push({ lat, lon });
    L.circleMarker([lat, lon], {
      radius: 5,
      color: "#4a9fd4",
      fillOpacity: 1,
    }).addTo(tempLayer);
    if (areaPts.length >= 2) {
      tempLayer.eachLayer((l) => {
        if (l instanceof L.Polyline && !(l instanceof L.Polygon)) tempLayer.removeLayer(l);
      });
      L.polyline(
        areaPts.map((p) => [p.lat, p.lon]),
        { color: "#4a9fd4", weight: 2, dashArray: "4 4" }
      ).addTo(tempLayer);
    }
    setModeBanner(`${areaPts.length} köşe — Bitir ile tamamla`);
    return;
  }

  updateInfo(lat, lon, { fromMap: true });
}

function finishMeasureLine(a, b) {
  clearTemp();
  const dist = distanceM(a.lat, a.lon, b.lat, b.lon);
  const mil = bearingMil(a.lat, a.lon, b.lat, b.lon);
  const name = $("#measureName").value.trim();
  L.circleMarker([a.lat, a.lon], { radius: 6, color: "#e8b84a", fillOpacity: 1 }).addTo(tempLayer);
  L.circleMarker([b.lat, b.lon], { radius: 6, color: "#e8b84a", fillOpacity: 1 }).addTo(tempLayer);
  L.polyline(
    [
      [a.lat, a.lon],
      [b.lat, b.lon],
    ],
    { color: "#3d9a6a", weight: 3 }
  ).addTo(tempLayer);
  labelLine(tempLayer, a, b, dist, mil, name);
  pendingShape = { type: measureKind, pts: [a, b], dist, mil, name };
  const html =
    measureKind === "measure"
      ? `<strong>Mesafe:</strong> ${fmtDist(dist)}<br/><strong>İstikamet:</strong> ${mil} milyem<br/><strong>A→B:</strong> ${toMgrs(a.lat, a.lon)} → ${toMgrs(b.lat, b.lon)}`
      : `<strong>İstikamet:</strong> ${mil} milyem<br/><strong>Mesafe:</strong> ${fmtDist(dist)}<br/><strong>Başlangıç:</strong> ${toMgrs(a.lat, a.lon)}<br/><strong>Bitiş:</strong> ${toMgrs(b.lat, b.lon)}`;
  showResult(measureKind === "measure" ? "Mesafe" : "İstikamet", html, name);
  setModeBanner("");
  activeTool = null;
  clearToolHighlight();
  measurePts = [];
}

function finishArea() {
  if (areaPts.length === 0) {
    toast("Önce Alan seçin");
    activeTool = null;
    clearToolHighlight();
    return;
  }
  if (areaPts.length < 3) {
    toast("En az 3 köşe gerekli");
    activeTool = "area";
    map.doubleClickZoom.disable();
    highlightTool("area");
    return;
  }
  const area = polygonArea(areaPts);
  clearTemp();
  L.polygon(
    areaPts.map((p) => [p.lat, p.lon]),
    { color: "#4a9fd4", weight: 2, fillOpacity: 0.2 }
  ).addTo(tempLayer);
  labelAreaShape(tempLayer, areaPts, area, "");
  pendingShape = { type: "area", pts: [...areaPts], area };
  showResult("Alan", `<strong>Alan:</strong> ${fmtArea(area)}<br/><strong>Köşe:</strong> ${areaPts.length}`, "");
  areaPts = [];
  setModeBanner("");
  activeTool = null;
  resetMapInteractions();
  clearToolHighlight();
}

/* —— Pen: multi-stroke; lift finger does NOT open save dialog —— */
function eventToLatLng(e) {
  return map ? map.mouseEventToLatLng(e) : null;
}

function discardCurrentStroke() {
  if (drawLine) {
    tempLayer.removeLayer(drawLine);
    drawLine = null;
  }
  drawing = false;
}

function onDrawStart(e) {
  if (activeTool !== "draw") return;
  if (e.target.closest?.(".leaflet-control, .draw-bar, .toolbar, .topbar, button, .sheet, .sheet-backdrop")) {
    return;
  }

  drawPointers.add(e.pointerId);

  // İki parmak / çoklu dokunuş → çizme, haritayı gez
  if (drawPointers.size > 1) {
    drawMultiTouch = true;
    discardCurrentStroke();
    map.dragging.enable();
    return;
  }

  if (drawMultiTouch) return;

  e.preventDefault();
  map.dragging.disable();
  const ll = eventToLatLng(e);
  if (!ll) return;
  drawing = true;
  drawLine = L.polyline([[ll.lat, ll.lng]], { color: "#e8b84a", weight: 3 }).addTo(tempLayer);
}

function onDrawMove(e) {
  if (activeTool !== "draw") return;
  if (drawMultiTouch || drawPointers.size > 1) return;
  if (!drawing || !drawLine) return;
  e.preventDefault();
  const ll = eventToLatLng(e);
  if (!ll) return;
  drawLine.addLatLng([ll.lat, ll.lng]);
}

function onDrawPointerUp(e) {
  if (activeTool !== "draw") {
    drawPointers.clear();
    drawMultiTouch = false;
    return;
  }

  drawPointers.delete(e.pointerId);

  if (drawMultiTouch) {
    if (drawPointers.size === 0) {
      drawMultiTouch = false;
      map.dragging.disable();
      setModeBanner(
        drawStrokes.length
          ? `${drawStrokes.length} çizgi — Kaydet ile kaydedin`
          : "Kalem: tek parmak çiz, iki parmak gez"
      );
    }
    return;
  }

  if (!drawing) return;
  drawing = false;
  if (drawLine) {
    const latlngs = drawLine.getLatLngs();
    if (latlngs.length >= 2) {
      drawStrokes.push(latlngs.map((p) => ({ lat: p.lat, lon: p.lng })));
    } else {
      tempLayer.removeLayer(drawLine);
    }
    drawLine = null;
    setModeBanner(
      drawStrokes.length
        ? `${drawStrokes.length} çizgi — Kaydet ile kaydedin`
        : "Kalem: tek parmak çiz, iki parmak gez"
    );
  }
}

function undoDrawStroke() {
  if (!drawStrokes.length) return toast("Geri alınacak çizgi yok");
  drawStrokes.pop();
  redrawDrawTemp();
  setModeBanner(drawStrokes.length ? `${drawStrokes.length} çizgi` : "Kalem: çizin");
}

function clearDrawStrokes() {
  drawStrokes = [];
  tempLayer.clearLayers();
  pendingShape = null;
  setModeBanner("Kalem: çizin — bitince Kaydet");
}

function redrawDrawTemp() {
  tempLayer.clearLayers();
  pendingShape = null;
  for (const stroke of drawStrokes) {
    L.polyline(
      stroke.map((p) => [p.lat, p.lon]),
      { color: "#e8b84a", weight: 3 }
    ).addTo(tempLayer);
  }
}

function saveDrawStrokes() {
  if (!drawStrokes.length) return toast("Çizim yok");
  askName("Çizim", (name) => {
    const strokes = drawStrokes.map((s) => s.map((p) => ({ ...p })));
    const first = strokes[0];
    const midPt = first[Math.floor(first.length / 2)];
    const sh = {
      id: uid(),
      type: "draw",
      name: name || "Çizim",
      strokes,
      labelLat: midPt.lat,
      labelLon: midPt.lon,
      savedAt: new Date().toISOString(),
    };
    state.drawings.push(sh);
    persist();
    drawStrokes = [];
    clearTemp();
    $("#drawBar").hidden = true;
    activeTool = null;
    resetMapInteractions();
    clearToolHighlight();
    setModeBanner("");
    renderSaved();
    toast(`Kaydedildi: ${sh.name}`);
  });
}

function drawCircleAt(lat, lon) {
  const r = Number($("#circleRadius").value) || 500;
  const name = $("#circleName").value.trim();
  clearTemp();
  L.circle([lat, lon], { radius: r, color: "#3d9a6a", fillOpacity: 0.15, weight: 2 }).addTo(tempLayer);
  L.circleMarker([lat, lon], { radius: 5, color: "#e8b84a", fillOpacity: 1 }).addTo(tempLayer);
  const edge = destination(lat, lon, 1600, r);
  L.polyline(
    [
      [lat, lon],
      [edge.lat, edge.lon],
    ],
    { color: "#e8b84a", weight: 2, dashArray: "4 4" }
  ).addTo(tempLayer);
  labelCircleShape(tempLayer, lat, lon, r, name);
  const area = circleArea(r);
  const html = `<strong>Yarıçap:</strong> ${fmtDist(r)}<br/><strong>Alan:</strong> ${fmtArea(area)}<br/><strong>MGRS:</strong> ${toMgrs(lat, lon)}`;
  $("#circleResult").innerHTML = html;
  pendingShape = { type: "circle", center: { lat, lon }, radius: r, area, name };
  showResult("Daire", html, name);
  toast("Daire çizildi");
}

function drawArcAt(lat, lon) {
  const main = Number($("#arcBearing").value) || 0;
  const dist = Number($("#arcDist").value) || 1000;
  const right = Number($("#arcRight").value) || 0;
  const left = Number($("#arcLeft").value) || 0;
  const name = $("#arcName").value.trim();
  clearTemp();
  const { pts, startMil, endMil, mainMil } = arcPoints(lat, lon, main, dist, left, right);
  L.polyline(
    pts.map((p) => [p.lat, p.lon]),
    { color: "#e8b84a", weight: 3 }
  ).addTo(tempLayer);
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
  labelArcShape(tempLayer, lat, lon, mainMil, dist, left, right, startMil, endMil, name);
  const html =
    `<strong>İstikamet:</strong> ${mainMil} milyem<br/>` +
    `<strong>Mesafe:</strong> ${fmtDist(dist)}<br/>` +
    `<strong>Sağ:</strong> ${right} (→ ${endMil})<br/>` +
    `<strong>Sol:</strong> ${left} (→ ${startMil})<br/>` +
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
    name,
  };
  showResult("Kavis", html, name);
  toast("Kavis çizildi");
}

function savePointAt(lat, lon, name) {
  const pt = {
    id: uid(),
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
  map.setView([lat, lon], Math.max(map.getZoom(), 14));
}

function renderSaved() {
  savedLayer.clearLayers();
  for (const p of state.points) {
    L.circleMarker([p.lat, p.lon], {
      radius: 7,
      color: "#e8b84a",
      fillColor: "#1a2332",
      fillOpacity: 1,
      weight: 3,
    })
      .addTo(savedLayer)
      .bindPopup(`<b>${escapeHtml(p.name)}</b><br/>${escapeHtml(p.mgrs || toMgrs(p.lat, p.lon))}`);
    addMapLabel(
      savedLayer,
      p.lat,
      p.lon,
      `<span class="name">${escapeHtml(p.name)}</span>`,
      false
    );
  }
  for (const sh of state.shapes) addShapeToLayer(sh, savedLayer);
  for (const d of state.drawings) {
    if (d.strokes?.length) {
      for (const stroke of d.strokes) {
        if (stroke?.length) {
          L.polyline(
            stroke.map((p) => [p.lat, p.lon]),
            { color: "#e8b84a", weight: 3, opacity: 0.9 }
          ).addTo(savedLayer);
        }
      }
      if (d.name && d.labelLat != null) {
        addMapLabel(
          savedLayer,
          d.labelLat,
          d.labelLon,
          `<span class="name">${escapeHtml(d.name)}</span>`
        );
      }
    } else if (d.pts?.length) {
      L.polyline(
        d.pts.map((p) => [p.lat, p.lon]),
        { color: "#e8b84a", weight: 3, opacity: 0.9 }
      ).addTo(savedLayer);
      if (d.name) {
        const midPt = d.pts[Math.floor(d.pts.length / 2)];
        addMapLabel(
          savedLayer,
          midPt.lat,
          midPt.lon,
          `<span class="name">${escapeHtml(d.name)}</span>`
        );
      }
    }
  }
  renderLists();
}

function addShapeToLayer(sh, layer) {
  const name = sh.name || "";
  if (sh.type === "circle" && sh.center) {
    L.circle([sh.center.lat, sh.center.lon], {
      radius: sh.radius,
      color: "#3d9a6a",
      fillOpacity: 0.12,
      weight: 2,
    }).addTo(layer);
    const edge = destination(sh.center.lat, sh.center.lon, 1600, sh.radius);
    L.polyline(
      [
        [sh.center.lat, sh.center.lon],
        [edge.lat, edge.lon],
      ],
      { color: "#e8b84a", weight: 2, dashArray: "4 4" }
    ).addTo(layer);
    labelCircleShape(layer, sh.center.lat, sh.center.lon, sh.radius, name);
  } else if (sh.type === "arc" && sh.pts) {
    L.polyline(
      sh.pts.map((p) => [p.lat, p.lon]),
      { color: "#e8b84a", weight: 3 }
    ).addTo(layer);
    if (sh.center) {
      labelArcShape(
        layer,
        sh.center.lat,
        sh.center.lon,
        sh.mainMil,
        sh.dist,
        sh.left,
        sh.right,
        sh.startMil,
        sh.endMil,
        name
      );
    }
  } else if ((sh.type === "measure" || sh.type === "bearing") && sh.pts?.length === 2) {
    L.polyline(
      [
        [sh.pts[0].lat, sh.pts[0].lon],
        [sh.pts[1].lat, sh.pts[1].lon],
      ],
      { color: "#3d9a6a", weight: 2 }
    ).addTo(layer);
    labelLine(layer, sh.pts[0], sh.pts[1], sh.dist, sh.mil, name);
  } else if (sh.type === "area" && sh.pts) {
    L.polygon(
      sh.pts.map((p) => [p.lat, p.lon]),
      { color: "#4a9fd4", weight: 2, fillOpacity: 0.15 }
    ).addTo(layer);
    labelAreaShape(layer, sh.pts, sh.area, name);
  } else if (sh.type === "parsel" && sh.pts?.length) {
    L.polygon(
      sh.pts.map((p) => [p.lat, p.lon]),
      { color: "#c45c26", weight: 2, fillColor: "#c45c26", fillOpacity: 0.2 }
    ).addTo(layer);
    const c = sh.center || centroid(sh.pts);
    const label =
      (name ? `<span class="name">${escapeHtml(name)}</span>` : "") +
      `<span class="hl">${escapeHtml(sh.ozet || "")}</span>` +
      (sh.alan ? `<br/>${escapeHtml(String(sh.alan))} m²` : "");
    addMapLabel(layer, c.lat, c.lon, label, true);
  }
}

function renderLists() {
  const pl = $("#pointsList");
  pl.innerHTML = state.points.length
    ? state.points
        .map(
          (p, i) => `<li>
        <div class="meta" data-go-kind="point" data-go-i="${i}">
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="sub">${escapeHtml(p.mgrs || "")}</div>
        </div>
        <button type="button" class="btn icon" data-go-kind="point" data-go-i="${i}" title="Git">➤</button>
        <button type="button" class="btn icon danger" data-del-pt="${escapeHtml(p.id)}">🗑</button>
      </li>`
        )
        .join("")
    : `<li><div class="meta"><div class="sub">Kayıtlı nokta yok</div></div></li>`;

  const items = [
    ...state.shapes.map((s, i) => ({
      kind: "shape",
      i,
      name: s.name || s.type,
      sub: s.summary || s.type,
    })),
    ...state.drawings.map((d, i) => ({
      kind: "draw",
      i,
      name: d.name || "Çizim",
      sub: `${d.strokes?.length || 1} çizgi`,
    })),
  ];
  const sl = $("#shapesList");
  sl.innerHTML = items.length
    ? items
        .map(
          (x) => `<li>
        <div class="meta" data-go-kind="${x.kind}" data-go-i="${x.i}">
          <div class="name">${escapeHtml(x.name)}</div>
          <div class="sub">${escapeHtml(x.sub)}</div>
        </div>
        <button type="button" class="btn icon" data-go-kind="${x.kind}" data-go-i="${x.i}" title="Git">➤</button>
        <button type="button" class="btn icon danger" data-del-kind="${x.kind}" data-del-i="${x.i}">🗑</button>
      </li>`
        )
        .join("")
    : `<li><div class="meta"><div class="sub">Kayıtlı şekil yok</div></div></li>`;
}

async function updateInfo(lat, lon, opts = {}) {
  lastFocus = { lat, lon };
  const mgrs = toMgrs(lat, lon);
  $("#infoMgrs").textContent = mgrs;
  const llEl = $("#infoLl");
  if (llEl) llEl.textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  if (lastGps && !opts.fromMap) {
    $("#infoAcc").textContent = lastGps.acc != null ? `±${Math.round(lastGps.acc)} m` : "—";
  }
  if (!navigator.onLine) {
    $("#infoElev").textContent = "çevrimdışı";
    $("#infoSlope").textContent = "—";
    return;
  }
  try {
    const { elev, slope } = await getSlopeNear(lat, lon);
    if (elev != null) $("#infoElev").textContent = `${Math.round(elev)} m`;
    if (slope != null) $("#infoSlope").textContent = `%${slope.toFixed(1)}`;
  } catch (_) {}
}

async function copyText(text) {
  const t = String(text || "").trim();
  if (!t || t === "—") return toast("Kopyalanacak yok");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(t);
    } else {
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast("Kopyalandı");
  } catch (_) {
    toast("Kopyalanamadı");
  }
}

function itemCenter(kind, index) {
  if (kind === "point") {
    const p = state.points[index];
    return p ? { lat: p.lat, lon: p.lon, zoom: 16 } : null;
  }
  if (kind === "shape") {
    const sh = state.shapes[index];
    if (!sh) return null;
    if (sh.center) return { lat: sh.center.lat, lon: sh.center.lon, zoom: 15 };
    if (sh.pts?.length) {
      const c = centroid(sh.pts);
      return { lat: c.lat, lon: c.lon, zoom: 15 };
    }
  }
  if (kind === "draw") {
    const d = state.drawings[index];
    if (!d) return null;
    if (d.labelLat != null) return { lat: d.labelLat, lon: d.labelLon, zoom: 15 };
    const stroke = d.strokes?.[0] || d.pts;
    if (stroke?.length) {
      const midPt = stroke[Math.floor(stroke.length / 2)];
      return { lat: midPt.lat, lon: midPt.lon, zoom: 15 };
    }
  }
  return null;
}

function goToItem(kind, index) {
  const c = itemCenter(kind, index);
  if (!c) return toast("Konum yok");
  map.setView([c.lat, c.lon], c.zoom || 15);
  updateInfo(c.lat, c.lon);
  closeSheets();
}

async function refreshWeather() {
  const c = lastGps || { lat: map.getCenter().lat, lon: map.getCenter().lng };
  const lat = c.lat;
  const lon = c.lon ?? c.lng;
  toast("Hava alınıyor…");
  const w = await getWeather(lat, lon);
  if (!w) {
    $("#infoWeather").textContent = navigator.onLine ? "alınamadı" : "çevrimdışı";
    return toast("Hava alınamadı");
  }
  $("#infoWeather").textContent = `${w.desc}, ${w.temp}°C, nem %${w.humidity}, rüzgar ${w.wind} m/s`;
  toast("Hava güncellendi");
}

function startGps() {
  if (!navigator.geolocation) return toast("Konum desteklenmiyor");
  navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude: lat, longitude: lon, accuracy: acc, altitude: alt } = pos.coords;
      lastGps = { lat, lon, acc, alt };
      $("#infoAcc").textContent = acc != null ? `±${Math.round(acc)} m (GPS)` : "—";
      if (alt != null) $("#infoElev").textContent = `${Math.round(alt)} m (GPS)`;
      lastFocus = { lat, lon };
      $("#infoMgrs").textContent = toMgrs(lat, lon);
      const llEl = $("#infoLl");
      if (llEl) llEl.textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
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
        lastGps = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          acc: pos.coords.accuracy,
          alt: pos.coords.altitude,
        };
        map.setView([lastGps.lat, lastGps.lon], Math.max(map.getZoom(), 15));
        updateInfo(lastGps.lat, lastGps.lon);
        refreshWeather();
      },
      () => toast("Konum alınamadı"),
      { enableHighAccuracy: true, timeout: 12000 }
    );
    return;
  }
  map.setView([lastGps.lat, lastGps.lon], Math.max(map.getZoom(), 15));
  updateInfo(lastGps.lat, lastGps.lon);
  refreshWeather();
}

function applyChromeHidden(hidden) {
  const app = $("#app");
  const btn = $("#btnChromeToggle");
  app.classList.toggle("chrome-hidden", !!hidden);
  if (btn) {
    btn.textContent = hidden ? "▲" : "▼";
    btn.title = hidden ? "Alt menüyü göster" : "Alt menüyü gizle";
  }
  state.settings.chromeHidden = !!hidden;
  setTimeout(() => map?.invalidateSize(), 50);
}

function toggleChrome() {
  applyChromeHidden(!$("#app").classList.contains("chrome-hidden"));
  persist();
  toast($("#app").classList.contains("chrome-hidden") ? "Alt menü gizli" : "Alt menü açık");
}

function syncCircleCenterUi() {
  $("#circleSavedWrap").classList.toggle("hidden", $("#circleCenter").value !== "saved");
}
function syncArcCenterUi() {
  $("#arcSavedWrap").classList.toggle("hidden", $("#arcCenter").value !== "saved");
}
function syncSavePtUi() {
  const src = $("#savePtSrc").value;
  $("#savePtManual").classList.toggle("hidden", src !== "manual");
  const fmt = $("#savePtFmt").value;
  $("#savePtMgrsWrap").classList.toggle("hidden", fmt !== "mgrs");
  $("#savePtLlWrap").classList.toggle("hidden", fmt !== "ll");
}

function syncParselModeUi() {
  $("#parselAdaFields").classList.toggle("hidden", $("#parselMode").value !== "ada");
}

let illerLoaded = false;

async function ensureIllerLoaded() {
  if (illerLoaded) return;
  const sel = $("#parselIl");
  try {
    sel.innerHTML = `<option value="">Yükleniyor…</option>`;
    const list = await fetchIller();
    sel.innerHTML =
      `<option value="">İl seçin</option>` +
      list.map((x) => `<option value="${x.id}">${escapeHtml(x.text)}</option>`).join("");
    illerLoaded = true;
  } catch (e) {
    sel.innerHTML = `<option value="">İller alınamadı</option>`;
    toast("İl listesi alınamadı (internet?)");
  }
}

async function onParselIlChange() {
  const ilId = $("#parselIl").value;
  $("#parselMahalle").innerHTML = `<option value="">Önce ilçe seçin</option>`;
  const sel = $("#parselIlce");
  if (!ilId) {
    sel.innerHTML = `<option value="">Önce il seçin</option>`;
    return;
  }
  sel.innerHTML = `<option value="">Yükleniyor…</option>`;
  try {
    const list = await fetchIlceler(ilId);
    sel.innerHTML =
      `<option value="">İlçe seçin</option>` +
      list.map((x) => `<option value="${x.id}">${escapeHtml(x.text)}</option>`).join("");
  } catch (_) {
    sel.innerHTML = `<option value="">İlçeler alınamadı</option>`;
  }
}

async function onParselIlceChange() {
  const ilceId = $("#parselIlce").value;
  const sel = $("#parselMahalle");
  if (!ilceId) {
    sel.innerHTML = `<option value="">Önce ilçe seçin</option>`;
    return;
  }
  sel.innerHTML = `<option value="">Yükleniyor…</option>`;
  try {
    const list = await fetchMahalleler(ilceId);
    sel.innerHTML =
      `<option value="">Mahalle seçin</option>` +
      list.map((x) => `<option value="${x.id}">${escapeHtml(x.text)}</option>`).join("");
  } catch (_) {
    sel.innerHTML = `<option value="">Mahalleler alınamadı</option>`;
  }
}

async function queryParselAt(lat, lon) {
  if (!navigator.onLine) return toast("Parsel için internet gerekli");
  toast("Parsel sorgulanıyor…");
  try {
    const feat = await fetchParselByCoord(lat, lon);
    if (!feat?.geometry) {
      $("#parselResult").innerHTML = "Bu noktada parsel bulunamadı.";
      openSheet("#sheetParsel");
      return toast("Parsel yok");
    }
    showParselFeature(feat);
  } catch (e) {
    toast("Sorgu hatası: " + (e.message || e));
    openSheet("#sheetParsel");
  }
}

async function queryParselByAdaForm() {
  const mahalleId = $("#parselMahalle").value;
  const ada = $("#parselAda").value.trim();
  const no = $("#parselNo").value.trim();
  if (!mahalleId || !ada || !no) return toast("Mahalle, ada ve parsel gerekli");
  if (!navigator.onLine) return toast("Parsel için internet gerekli");
  toast("Parsel sorgulanıyor…");
  try {
    const feat = await fetchParselByAda(mahalleId, ada, no);
    if (!feat?.geometry) {
      $("#parselResult").innerHTML = "Parsel bulunamadı.";
      return toast("Parsel yok");
    }
    showParselFeature(feat);
  } catch (e) {
    toast("Sorgu hatası: " + (e.message || e));
  }
}

function showParselFeature(feature) {
  const props = feature.properties || {};
  const info = summarizeParsel(props);
  const pts = ringToLatLngs(feature.geometry.coordinates);
  if (pts.length < 3) return toast("Geometri geçersiz");
  const center = featureCenter(feature) || centroid(pts);
  const name = $("#parselName").value.trim() || info.title;

  clearTemp();
  L.polygon(
    pts.map((p) => [p.lat, p.lon]),
    { color: "#c45c26", weight: 2, fillColor: "#c45c26", fillOpacity: 0.25 }
  ).addTo(tempLayer);
  L.circleMarker([center.lat, center.lon], {
    radius: 5,
    color: "#fff",
    fillColor: "#c45c26",
    fillOpacity: 1,
  }).addTo(tempLayer);
  addMapLabel(
    tempLayer,
    center.lat,
    center.lon,
    `<span class="name">${escapeHtml(name)}</span><span class="hl">${escapeHtml(info.title)}</span><br/>${escapeHtml(String(info.alan))} m²`,
    true
  );

  map.fitBounds(
    L.latLngBounds(pts.map((p) => [p.lat, p.lon])),
    { padding: [40, 40], maxZoom: 18 }
  );

  pendingShape = {
    type: "parsel",
    name,
    pts,
    center,
    ozet: info.title,
    ada: info.ada,
    parsel: info.parsel,
    alan: info.alan,
    nitelik: info.nitelik,
    mahalle: info.mahalle,
    il: info.il,
    ilce: info.ilce,
    summary: `${info.title} · ${info.alan} m²`,
  };

  $("#parselResult").innerHTML = info.html + `<br/><span style="color:#8a9bb0">Kaynak: TKGM MEGSIS</span>`;
  showResult("Parsel", info.html, name);
  toast(info.title);
}

function defaultLabel(sh) {
  if (sh.type === "circle") return "Daire";
  if (sh.type === "arc") return "Kavis";
  if (sh.type === "area") return "Alan";
  if (sh.type === "bearing") return "İstikamet";
  if (sh.type === "measure") return "Mesafe";
  if (sh.type === "draw") return "Çizim";
  if (sh.type === "parsel") return sh.ozet || "Parsel";
  return "Şekil";
}

function mergeById(a, b) {
  const m = new Map(a.map((x) => [x.id, x]));
  for (const x of b) m.set(x.id || uid(), x);
  return [...m.values()];
}

function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
}

function bindUi() {
  $("#btnLocate").addEventListener("click", goToLocation);
  $("#btnChromeToggle").addEventListener("click", toggleChrome);
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
        if (t === "draw") exitDrawMode(true);
        setTool(null);
        clearTemp();
        setModeBanner("");
        clearToolHighlight();
        return;
      }
      setTool(t);
    })
  );

  $("#measureMode").addEventListener("change", () => {
    $("#measureSavedFields").classList.toggle("hidden", $("#measureMode").value !== "saved");
  });

  $("#btnMeasureGo").addEventListener("click", () => {
    const mode = $("#measureMode").value;
    closeSheets();
    activeTool = measureKind;
    highlightTool(measureKind);
    clearTemp();

    if (mode === "saved") {
      const a = getPointById($("#measureFrom").value);
      const b = getPointById($("#measureTo").value);
      if (!a || !b) return toast("İki kayıtlı nokta seçin");
      finishMeasureLine({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon });
      return;
    }
    if (mode === "gps-map") {
      if (!lastGps) return toast("Konum yok");
      measurePts = [{ lat: lastGps.lat, lon: lastGps.lon }];
      L.circleMarker([lastGps.lat, lastGps.lon], {
        radius: 6,
        color: "#e8b84a",
        fillOpacity: 1,
      }).addTo(tempLayer);
      pickMode = "measure2";
      setModeBanner("2. noktaya dokun");
      return;
    }
    // map: two taps via pickMode measure1 → measure2
    measurePts = [];
    pickMode = "measure1";
    setModeBanner("1. noktaya dokun");
  });

  $("#circleCenter").addEventListener("change", syncCircleCenterUi);
  $("#arcCenter").addEventListener("change", syncArcCenterUi);
  $("#savePtSrc").addEventListener("change", syncSavePtUi);
  $("#savePtFmt").addEventListener("change", syncSavePtUi);

  $("#btnCircleDraw").addEventListener("click", () => {
    const mode = $("#circleCenter").value;
    if (mode === "gps") {
      if (!lastGps) return toast("Konum yok");
      drawCircleAt(lastGps.lat, lastGps.lon);
    } else if (mode === "saved") {
      const p = getPointById($("#circleSavedPt").value);
      if (!p) return toast("Nokta seçin");
      drawCircleAt(p.lat, p.lon);
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
    } else if (mode === "saved") {
      const p = getPointById($("#arcSavedPt").value);
      if (!p) return toast("Nokta seçin");
      drawArcAt(p.lat, p.lon);
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

  $("#parselMode").addEventListener("change", syncParselModeUi);
  $("#parselIl").addEventListener("change", onParselIlChange);
  $("#parselIlce").addEventListener("change", onParselIlceChange);
  $("#btnParselOfficial").addEventListener("click", () => {
    window.open(TKGM_SITE, "_blank", "noopener");
  });
  $("#btnParselClear").addEventListener("click", () => {
    clearTemp();
    $("#parselResult").innerHTML = "";
  });
  $("#btnParselGo").addEventListener("click", () => {
    const mode = $("#parselMode").value;
    if (mode === "gps") {
      if (!lastGps) return toast("Konum yok");
      closeSheets();
      queryParselAt(lastGps.lat, lastGps.lon);
    } else if (mode === "ada") {
      queryParselByAdaForm();
    } else {
      pickMode = "parsel";
      closeSheets();
      setModeBanner("Parsel için haritaya dokun");
      activeTool = "parsel";
      highlightTool("parsel");
    }
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
    } else if (src === "manual") {
      try {
        let lat;
        let lon;
        if ($("#savePtFmt").value === "mgrs") {
          ({ lat, lon } = fromMgrs($("#savePtMgrs").value));
        } else {
          lat = Number($("#savePtLat").value);
          lon = Number($("#savePtLon").value);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            throw new Error("Geçersiz enlem/boylam");
          }
        }
        savePointAt(lat, lon, name);
        closeSheets();
      } catch (err) {
        toast("Koordinat hatası: " + (err.message || err));
      }
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
    const name = $("#resultName").value.trim() || pendingShape.name || "";
    const sh = {
      ...pendingShape,
      id: uid(),
      name: name || defaultLabel(pendingShape),
      savedAt: new Date().toISOString(),
    };
    if (sh.type === "circle") sh.summary = `r=${sh.radius}m · ${fmtArea(sh.area)}`;
    else if (sh.type === "arc") sh.summary = `${sh.mainMil} · ${sh.dist}m`;
    else if (sh.type === "area") sh.summary = fmtArea(sh.area);
    else if (sh.type === "parsel") sh.summary = sh.summary || sh.ozet || "Parsel";
    else if (sh.dist != null) sh.summary = `${fmtDist(sh.dist)} · ${sh.mil} milyem`;
    state.shapes.push(sh);
    persist();
    renderSaved();
    clearTemp();
    closeSheets();
    toast(`Kaydedildi: ${sh.name}`);
  });

  $("#btnNameOk").addEventListener("click", () => {
    const n = $("#nameInput").value.trim();
    const cb = nameCallback;
    nameCallback = null;
    closeSheets();
    if (cb) cb(n);
  });

  $("#btnDrawUndo").addEventListener("click", undoDrawStroke);
  $("#btnDrawClear").addEventListener("click", clearDrawStrokes);
  $("#btnDrawSave").addEventListener("click", saveDrawStrokes);

  $("#btnExportAll").addEventListener("click", async () => {
    const r = await shareOrDownload(`mksi-${dateStamp()}.json`, exportJson(state, "all"));
    if (r !== "abort") toast(r.startsWith("shared") ? "Paylaşım açıldı" : "Dosya indirildi");
  });
  $("#btnExportPts").addEventListener("click", async () => {
    const r = await shareOrDownload(
      `mksi-noktalar-${dateStamp()}.json`,
      exportJson(state, "points")
    );
    if (r !== "abort") toast(r.startsWith("shared") ? "Paylaşım açıldı" : "Dosya indirildi");
  });
  $("#btnImport").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const data = parseImport(await file.text());
      if (data.points.length) state.points = mergeById(state.points, data.points);
      if (data.shapes.length) state.shapes = state.shapes.concat(data.shapes);
      if (data.drawings.length) state.drawings = state.drawings.concat(data.drawings);
      await persist();
      renderSaved();
      toast("İçe aktarıldı");
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
    const del = e.target.closest("[data-del-pt]");
    const go = e.target.closest("[data-go-kind]");
    if (del) {
      state.points = state.points.filter((x) => x.id !== del.dataset.delPt);
      persist();
      renderSaved();
      return;
    }
    if (go) {
      goToItem(go.dataset.goKind, Number(go.dataset.goI));
    }
  });

  $("#shapesList").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del-kind]");
    const go = e.target.closest("[data-go-kind]");
    if (del) {
      const i = Number(del.dataset.delI);
      if (del.dataset.delKind === "shape") state.shapes.splice(i, 1);
      else state.drawings.splice(i, 1);
      persist();
      renderSaved();
      return;
    }
    if (go) {
      goToItem(go.dataset.goKind, Number(go.dataset.goI));
    }
  });

  $("#infoMgrs").addEventListener("click", () => {
    copyText($("#infoMgrs").textContent);
  });
  $("#infoLl")?.addEventListener("click", () => {
    copyText($("#infoLl").textContent);
  });

  window.addEventListener("online", setNetDot);
  window.addEventListener("offline", setNetDot);
  setNetDot();
}

async function registerSw() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (_) {}
}

async function boot() {
  state = await loadState();
  if (!state.settings) state.settings = {};
  initMap();
  bindUi();
  applyChromeHidden(!!state.settings.chromeHidden);
  startGps();
  registerSw();
  const c = map.getCenter();
  updateInfo(c.lat, c.lng, { fromMap: true });
}

boot();
