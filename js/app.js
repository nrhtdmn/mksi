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
  exportFileName,
} from "./storage.js";
import { getSlopeNear, getWeather } from "./weather.js";

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
let pickMode = null; // circle | arc | savept | parsel | measure1 | measure2
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
let drawStrokePts = []; // current stroke [{lat,lon}]
let drawLastPx = null; // {x,y} last pixel for spacing
let drawPrimaryId = null;
let pendingShape = null;
let nameCallback = null;
let tracking = false;
let trackPts = [];
let trackLine = null;
let wakeLockSentinel = null;
let quickPoint = null;

function toast(msg, ms = 2200) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), ms);
}

const COLOR_PRESETS = [
  "#3d9a6a",
  "#e8b84a",
  "#4a9fd4",
  "#d64545",
  "#c45c26",
  "#9b59b6",
  "#1abc9c",
  "#ecf0f1",
];

function initSwatches(containerId, inputId) {
  const box = $(containerId);
  const input = $(inputId);
  if (!box || !input) return;
  box.innerHTML = COLOR_PRESETS.map(
    (c) =>
      `<button type="button" class="swatch${input.value.toLowerCase() === c.toLowerCase() ? " active" : ""}" data-color="${c}" style="background:${c}" title="${c}"></button>`
  ).join("");
  box.onclick = (e) => {
    const b = e.target.closest(".swatch");
    if (!b) return;
    input.value = b.dataset.color;
    box.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("active", s === b));
  };
  input.addEventListener("input", () => {
    box.querySelectorAll(".swatch").forEach((s) => {
      s.classList.toggle("active", s.dataset.color.toLowerCase() === input.value.toLowerCase());
    });
  });
}

function openEditShape(index) {
  const sh = state.shapes[index];
  if (!sh || (sh.type !== "circle" && sh.type !== "arc" && sh.type !== "area")) {
    return toast("Bu şekil düzenlenemez");
  }
  $("#editShapeIndex").value = String(index);
  $("#editShapeTitle").textContent =
    sh.type === "circle" ? "Daire düzenle" : sh.type === "arc" ? "Kavis düzenle" : "Alan düzenle";
  $("#editShapeName").value = sh.name || "";
  $("#editShapeColor").value =
    sh.color || (sh.type === "circle" ? "#3d9a6a" : sh.type === "arc" ? "#e8b84a" : "#4a9fd4");
  initSwatches("#editSwatches", "#editShapeColor");
  const isCircle = sh.type === "circle";
  const isArc = sh.type === "arc";
  $("#editCircleWrap").classList.toggle("hidden", !isCircle);
  $("#editArcWrap").classList.toggle("hidden", !isArc);
  if (isCircle) {
    $("#editCircleRadius").value = sh.radius || 500;
  } else if (isArc) {
    $("#editArcBearing").value = sh.mainMil ?? 3200;
    $("#editArcDist").value = sh.dist || 1000;
    $("#editArcRight").value = sh.right ?? 50;
    $("#editArcLeft").value = sh.left ?? 60;
  }
  openSheet("#sheetEditShape");
}

function saveEditShape() {
  const index = Number($("#editShapeIndex").value);
  const sh = state.shapes[index];
  if (!sh) return toast("Şekil yok");
  sh.name = $("#editShapeName").value.trim() || sh.name || defaultLabel(sh);
  sh.color = $("#editShapeColor").value || sh.color;
  if (sh.type === "circle") {
    const r = Number($("#editCircleRadius").value) || sh.radius;
    sh.radius = r;
    sh.area = circleArea(r);
    sh.summary = `r=${r}m · ${fmtArea(sh.area)}`;
  } else if (sh.type === "arc" && sh.center) {
    const main = Number($("#editArcBearing").value) || 0;
    const dist = Number($("#editArcDist").value) || 1000;
    const right = Number($("#editArcRight").value) || 0;
    const left = Number($("#editArcLeft").value) || 0;
    const { pts, startMil, endMil, mainMil } = arcPoints(
      sh.center.lat,
      sh.center.lon,
      main,
      dist,
      left,
      right
    );
    sh.mainMil = mainMil;
    sh.dist = dist;
    sh.right = right;
    sh.left = left;
    sh.startMil = startMil;
    sh.endMil = endMil;
    sh.pts = pts;
    sh.summary = `${mainMil} · ${dist}m`;
  } else if (sh.type === "area") {
    sh.summary = fmtArea(sh.area);
  }
  persist();
  renderSaved();
  closeSheets();
  toast(`Güncellendi: ${sh.name}`);
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
  if (map.touchZoom) map.touchZoom.enable();
  if (map.scrollWheelZoom) map.scrollWheelZoom.enable();
  if (map.tap) map.tap.enable();
  const el = map.getContainer();
  el.classList.remove("draw-mode");
  el.style.touchAction = "";
}

function enterDrawInteractions() {
  if (!map) return;
  map.dragging.disable();
  map.doubleClickZoom.disable();
  if (map.tap) map.tap.disable();
  const el = map.getContainer();
  el.classList.add("draw-mode");
  el.style.touchAction = "none";
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
  ["#measureFrom", "#measureTo", "#circleSavedPt", "#arcSavedPt", "#parselSavedPt"].forEach((sel) => {
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
  if (tracking && name !== "track" && name !== "finishArea") {
    stopTrack(false);
  }

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
    fillPointSelects();
    syncParselSrcUi();
    openSheet("#sheetParsel");
  } else if (name === "area") {
    areaPts = [];
    clearTemp();
    map.doubleClickZoom.disable();
    setModeBanner("Köşeleri işaretle — Bitir ile tamamla");
    toast("Alan: köşeleri işaretleyin");
  } else if (name === "finishArea") {
    if (tracking) finishTrackSave();
    else finishArea();
  } else if (name === "track") {
    startTrack();
  } else if (name === "draw") {
    enterDrawInteractions();
    $("#drawBar").hidden = false;
    setModeBanner("Kalem: tek parmak çiz, iki parmak gez");
    toast("Tek parmak: çiz · İki parmak: gez");
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
  const wrap = $("#resultColorWrap");
  if (wrap) {
    const isArea = pendingShape?.type === "area";
    wrap.classList.toggle("hidden", !isArea);
    if (isArea) {
      const col = pendingShape.color || "#4a9fd4";
      $("#resultColor").value = col;
      initSwatches("#resultSwatches", "#resultColor");
    }
  }
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

  map.on("move", () => {
    const c = map.getCenter();
    lastFocus = { lat: c.lat, lon: c.lng };
    $("#infoMgrs").textContent = toMgrs(c.lat, c.lng);
    $("#infoLat").textContent = c.lat.toFixed(6);
    $("#infoLon").textContent = c.lng.toFixed(6);
  });
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
  container.addEventListener("pointermove", onDrawMove, { passive: false });
  container.addEventListener("pointerup", onDrawPointerUp);
  container.addEventListener("pointercancel", onDrawPointerUp);
  container.addEventListener("lostpointercapture", (e) => {
    if (activeTool === "draw" && drawing && e.pointerId === drawPrimaryId) {
      finishCurrentStroke();
    }
  });

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
    showParselRedirect(lat, lon);
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
  const color = "#4a9fd4";
  clearTemp();
  L.polygon(
    areaPts.map((p) => [p.lat, p.lon]),
    { color, fillColor: color, weight: 2, fillOpacity: 0.22 }
  ).addTo(tempLayer);
  labelAreaShape(tempLayer, areaPts, area, "");
  pendingShape = { type: "area", pts: [...areaPts], area, color };
  showResult("Alan", `<strong>Alan:</strong> ${fmtArea(area)}<br/><strong>Köşe:</strong> ${areaPts.length}`, "");
  areaPts = [];
  setModeBanner("");
  activeTool = null;
  resetMapInteractions();
  clearToolHighlight();
}

/* —— Kalem: akıcı serbest çizim —— */
const DRAW_MIN_PX = 2; // pixel arası min mesafe (titreme azaltır)
const DRAW_LINE_OPTS = {
  color: "#e8b84a",
  weight: 4,
  opacity: 0.95,
  lineCap: "round",
  lineJoin: "round",
  smoothFactor: 0,
};

function eventToLatLng(e) {
  if (!map) return null;
  return map.mouseEventToLatLng(e);
}

function eventToContainerPoint(e) {
  if (!map) return null;
  return map.mouseEventToContainerPoint(e);
}

function discardCurrentStroke() {
  if (drawLine) {
    try {
      tempLayer.removeLayer(drawLine);
    } catch (_) {}
    drawLine = null;
  }
  drawing = false;
  drawStrokePts = [];
  drawLastPx = null;
  drawPrimaryId = null;
}

function finishCurrentStroke() {
  if (!drawing) return;
  drawing = false;
  if (drawLine && drawStrokePts.length >= 2) {
    drawStrokes.push(drawStrokePts.map((p) => ({ lat: p.lat, lon: p.lon })));
  } else if (drawLine) {
    try {
      tempLayer.removeLayer(drawLine);
    } catch (_) {}
  }
  drawLine = null;
  drawStrokePts = [];
  drawLastPx = null;
  drawPrimaryId = null;
  setModeBanner(
    drawStrokes.length
      ? `${drawStrokes.length} çizgi — Kaydet ile kaydedin`
      : "Kalem: tek parmak çiz, iki parmak gez"
  );
}

function appendDrawPoint(e) {
  const ll = eventToLatLng(e);
  const px = eventToContainerPoint(e);
  if (!ll || !px || !drawLine) return;

  if (drawLastPx) {
    const dx = px.x - drawLastPx.x;
    const dy = px.y - drawLastPx.y;
    if (dx * dx + dy * dy < DRAW_MIN_PX * DRAW_MIN_PX) return;
  }

  drawLastPx = { x: px.x, y: px.y };
  drawStrokePts.push({ lat: ll.lat, lon: ll.lng });
  drawLine.addLatLng([ll.lat, ll.lng]);
}

function onDrawStart(e) {
  if (activeTool !== "draw") return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  if (
    e.target.closest?.(
      ".leaflet-control, .draw-bar, .toolbar, .topbar, .chrome-fab, .locate-fab, .center-fab, button, .sheet, .sheet-backdrop"
    )
  ) {
    return;
  }

  drawPointers.add(e.pointerId);

  // İki parmak → çizimi bırak, haritayı gez
  if (drawPointers.size > 1) {
    drawMultiTouch = true;
    discardCurrentStroke();
    map.dragging.enable();
    if (map.touchZoom) map.touchZoom.enable();
    try {
      map.getContainer().releasePointerCapture?.(e.pointerId);
    } catch (_) {}
    return;
  }

  if (drawMultiTouch) return;

  e.preventDefault();
  e.stopPropagation();

  try {
    map.getContainer().setPointerCapture(e.pointerId);
  } catch (_) {}

  map.dragging.disable();
  drawPrimaryId = e.pointerId;
  drawing = true;
  drawStrokePts = [];
  drawLastPx = null;

  const ll = eventToLatLng(e);
  const px = eventToContainerPoint(e);
  if (!ll || !px) {
    drawing = false;
    return;
  }

  drawLastPx = { x: px.x, y: px.y };
  drawStrokePts.push({ lat: ll.lat, lon: ll.lng });
  drawLine = L.polyline([[ll.lat, ll.lng]], DRAW_LINE_OPTS).addTo(tempLayer);
}

function onDrawMove(e) {
  if (activeTool !== "draw") return;
  if (drawMultiTouch || drawPointers.size > 1) return;
  if (!drawing || !drawLine) return;
  if (drawPrimaryId != null && e.pointerId !== drawPrimaryId) return;

  e.preventDefault();
  appendDrawPoint(e);
}

function onDrawPointerUp(e) {
  if (activeTool !== "draw") {
    drawPointers.clear();
    drawMultiTouch = false;
    return;
  }

  drawPointers.delete(e.pointerId);

  try {
    if (map.getContainer().hasPointerCapture?.(e.pointerId)) {
      map.getContainer().releasePointerCapture(e.pointerId);
    }
  } catch (_) {}

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

  // pointercancel gelirse de mevcut çizgiyi kaydet (küçük kopuk parçalar olmasın)
  if (drawPrimaryId != null && e.pointerId !== drawPrimaryId) return;
  if (drawing) finishCurrentStroke();
}

function undoDrawStroke() {
  if (!drawStrokes.length) return toast("Geri alınacak çizgi yok");
  drawStrokes.pop();
  redrawDrawTemp();
  setModeBanner(drawStrokes.length ? `${drawStrokes.length} çizgi` : "Kalem: çizin");
}

function clearDrawStrokes() {
  drawStrokes = [];
  discardCurrentStroke();
  tempLayer.clearLayers();
  pendingShape = null;
  setModeBanner("Kalem: tek parmak çiz, iki parmak gez");
}

function redrawDrawTemp() {
  tempLayer.clearLayers();
  pendingShape = null;
  drawLine = null;
  drawing = false;
  for (const stroke of drawStrokes) {
    if (stroke?.length) {
      L.polyline(
        stroke.map((p) => [p.lat, p.lon]),
        DRAW_LINE_OPTS
      ).addTo(tempLayer);
    }
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
  const color = $("#circleColor")?.value || "#3d9a6a";
  clearTemp();
  paintCircle(tempLayer, { lat, lon }, r, color, name);
  const area = circleArea(r);
  const html = `<strong>Yarıçap:</strong> ${fmtDist(r)}<br/><strong>Alan:</strong> ${fmtArea(area)}<br/><strong>MGRS:</strong> ${toMgrs(lat, lon)}`;
  $("#circleResult").innerHTML = html;
  pendingShape = { type: "circle", center: { lat, lon }, radius: r, area, name, color };
  showResult("Daire", html, name);
  toast("Daire çizildi");
}

function paintCircle(layer, center, radius, color, name) {
  const c = color || "#3d9a6a";
  L.circle([center.lat, center.lon], {
    radius,
    color: c,
    fillColor: c,
    fillOpacity: 0.22,
    weight: 3,
  }).addTo(layer);
  L.circleMarker([center.lat, center.lon], {
    radius: 5,
    color: "#fff",
    fillColor: c,
    fillOpacity: 1,
    weight: 2,
  }).addTo(layer);
  const edge = destination(center.lat, center.lon, 1600, radius);
  L.polyline(
    [
      [center.lat, center.lon],
      [edge.lat, edge.lon],
    ],
    { color: c, weight: 2, dashArray: "4 4" }
  ).addTo(layer);
  labelCircleShape(layer, center.lat, center.lon, radius, name);
}

function drawArcAt(lat, lon) {
  const main = Number($("#arcBearing").value) || 0;
  const dist = Number($("#arcDist").value) || 1000;
  const right = Number($("#arcRight").value) || 0;
  const left = Number($("#arcLeft").value) || 0;
  const name = $("#arcName").value.trim();
  const color = $("#arcColor")?.value || "#e8b84a";
  clearTemp();
  const { pts, startMil, endMil, mainMil } = arcPoints(lat, lon, main, dist, left, right);
  paintArc(tempLayer, { lat, lon }, pts, mainMil, dist, left, right, startMil, endMil, color, name);
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
    color,
  };
  showResult("Kavis", html, name);
  toast("Kavis çizildi");
}

/** Dolu sektör + kenar çizgileri (daire gibi renkli) */
function paintArc(layer, center, pts, mainMil, dist, left, right, startMil, endMil, color, name) {
  const c = color || "#e8b84a";
  const sector = [{ lat: center.lat, lon: center.lon }, ...pts];
  L.polygon(
    sector.map((p) => [p.lat, p.lon]),
    { color: c, fillColor: c, fillOpacity: 0.22, weight: 2 }
  ).addTo(layer);
  L.polyline(
    pts.map((p) => [p.lat, p.lon]),
    { color: c, weight: 4, lineCap: "round" }
  ).addTo(layer);
  const leftPt = destination(center.lat, center.lon, startMil, dist);
  const rightPt = destination(center.lat, center.lon, endMil, dist);
  const midPt = destination(center.lat, center.lon, mainMil, dist);
  L.polyline(
    [
      [center.lat, center.lon],
      [midPt.lat, midPt.lon],
    ],
    { color: c, weight: 2, dashArray: "6 4" }
  ).addTo(layer);
  L.polyline(
    [
      [center.lat, center.lon],
      [leftPt.lat, leftPt.lon],
    ],
    { color: c, weight: 2, opacity: 0.7 }
  ).addTo(layer);
  L.polyline(
    [
      [center.lat, center.lon],
      [rightPt.lat, rightPt.lon],
    ],
    { color: c, weight: 2, opacity: 0.7 }
  ).addTo(layer);
  L.circleMarker([center.lat, center.lon], {
    radius: 5,
    color: "#fff",
    fillColor: c,
    fillOpacity: 1,
    weight: 2,
  }).addTo(layer);
  labelArcShape(layer, center.lat, center.lon, mainMil, dist, left, right, startMil, endMil, name);
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
            { ...DRAW_LINE_OPTS, opacity: 0.9 }
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
        { ...DRAW_LINE_OPTS, opacity: 0.9 }
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
    paintCircle(layer, sh.center, sh.radius, sh.color || "#3d9a6a", name);
  } else if (sh.type === "arc" && sh.pts) {
    if (sh.center) {
      paintArc(
        layer,
        sh.center,
        sh.pts,
        sh.mainMil,
        sh.dist,
        sh.left,
        sh.right,
        sh.startMil,
        sh.endMil,
        sh.color || "#e8b84a",
        name
      );
    } else {
      L.polyline(
        sh.pts.map((p) => [p.lat, p.lon]),
        { color: sh.color || "#e8b84a", weight: 3 }
      ).addTo(layer);
    }
  } else if ((sh.type === "measure" || sh.type === "bearing") && sh.pts?.length === 2) {
    L.polyline(
      [
        [sh.pts[0].lat, sh.pts[0].lon],
        [sh.pts[1].lat, sh.pts[1].lon],
      ],
      { color: sh.color || "#3d9a6a", weight: 2 }
    ).addTo(layer);
    labelLine(layer, sh.pts[0], sh.pts[1], sh.dist, sh.mil, name);
  } else if (sh.type === "area" && sh.pts) {
    const col = sh.color || "#4a9fd4";
    L.polygon(
      sh.pts.map((p) => [p.lat, p.lon]),
      { color: col, weight: 2, fillOpacity: 0.22, fillColor: col }
    ).addTo(layer);
    labelAreaShape(layer, sh.pts, sh.area, name);
  } else if (sh.type === "track" && sh.pts?.length) {
    L.polyline(
      sh.pts.map((p) => [p.lat, p.lon]),
      { color: sh.color || "#e85d4a", weight: 4 }
    ).addTo(layer);
    const midPt = sh.pts[Math.floor(sh.pts.length / 2)];
    const nameHtml = name ? `<span class="name">${escapeHtml(name)}</span>` : "";
    addMapLabel(
      layer,
      midPt.lat,
      midPt.lon,
      `${nameHtml}<span class="hl">${fmtDist(sh.dist || 0)}</span>`,
      true
    );
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
        <button type="button" class="btn icon" data-route-kind="point" data-route-i="${i}" title="Rota">🧭</button>
        <button type="button" class="btn icon" data-share-kind="point" data-share-i="${i}" title="Paylaş">📤</button>
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
      editable: s.type === "circle" || s.type === "arc" || s.type === "area",
      color: s.color || "",
    })),
    ...state.drawings.map((d, i) => ({
      kind: "draw",
      i,
      name: d.name || "Çizim",
      sub: `${d.strokes?.length || 1} çizgi`,
      editable: false,
      color: "",
    })),
  ];
  const sl = $("#shapesList");
  sl.innerHTML = items.length
    ? items
        .map(
          (x) => `<li>
        <div class="meta" data-go-kind="${x.kind}" data-go-i="${x.i}">
          <div class="name">${x.color ? `<span class="swatch-mini" style="background:${escapeHtml(x.color)}"></span>` : ""}${escapeHtml(x.name)}</div>
          <div class="sub">${escapeHtml(x.sub)}</div>
        </div>
        <button type="button" class="btn icon" data-go-kind="${x.kind}" data-go-i="${x.i}" title="Git">➤</button>
        <button type="button" class="btn icon" data-route-kind="${x.kind}" data-route-i="${x.i}" title="Rota">🧭</button>
        <button type="button" class="btn icon" data-share-kind="${x.kind}" data-share-i="${x.i}" title="Paylaş">📤</button>
        ${x.editable ? `<button type="button" class="btn icon" data-edit-shape="${x.i}" title="Düzenle">✎</button>` : ""}
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
  $("#infoLat").textContent = lat.toFixed(6);
  $("#infoLon").textContent = lon.toFixed(6);
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
      if (tracking) appendTrackPoint(lat, lon);
    },
    (err) => toast("Konum: " + (err.message || "hata")),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
}

function goToLocation() {
  if (!navigator.geolocation) return toast("Konum desteklenmiyor");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      const acc = pos.coords.accuracy;
      const alt = pos.coords.altitude;
      lastGps = { lat, lon, acc, alt };
      map.setView([lat, lon], Math.max(map.getZoom(), 17), { animate: true });
      if (gpsMarker) {
        gpsMarker.setLatLng([lat, lon]);
        if (gpsAccuracy) {
          gpsAccuracy.setLatLng([lat, lon]);
          gpsAccuracy.setRadius(acc || 20);
        }
      }
      $("#infoAcc").textContent = acc != null ? `±${Math.round(acc)} m (GPS)` : "—";
      if (alt != null) $("#infoElev").textContent = `${Math.round(alt)} m (GPS)`;
      updateInfo(lat, lon);
      toast("Konum ortalandı");
    },
    () => toast("Konum alınamadı"),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
  );
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLockSentinel = await navigator.wakeLock.request("screen");
      wakeLockSentinel.addEventListener("release", () => {});
    }
  } catch (_) {}
}

async function releaseWakeLock() {
  try {
    await wakeLockSentinel?.release();
  } catch (_) {}
  wakeLockSentinel = null;
}

function trackTotalDist() {
  let total = 0;
  for (let i = 1; i < trackPts.length; i++) {
    const a = trackPts[i - 1];
    const b = trackPts[i];
    total += distanceM(a.lat, a.lon, b.lat, b.lon);
  }
  return total;
}

function updateTrackLive() {
  const el = $("#trackLive");
  if (!el) return;
  el.textContent = `İz · ${trackPts.length} nokta · ${fmtDist(trackTotalDist())}`;
}

function redrawTrackLine() {
  if (trackLine) {
    try {
      tempLayer.removeLayer(trackLine);
    } catch (_) {}
    trackLine = null;
  }
  if (trackPts.length >= 2) {
    trackLine = L.polyline(
      trackPts.map((p) => [p.lat, p.lon]),
      { color: "#e85d4a", weight: 4 }
    ).addTo(tempLayer);
  }
}

function appendTrackPoint(lat, lon) {
  if (trackPts.length) {
    const last = trackPts[trackPts.length - 1];
    if (distanceM(last.lat, last.lon, lat, lon) < 4) {
      map.setView([lat, lon], map.getZoom(), { animate: false });
      return;
    }
  }
  trackPts.push({ lat, lon });
  redrawTrackLine();
  updateTrackLive();
  map.setView([lat, lon], map.getZoom(), { animate: false });
}

function startTrack() {
  if (tracking) return toast("İz zaten aktif");
  if (activeTool === "draw") exitDrawMode(true);
  areaPts = [];
  cancelPick();
  clearTemp();
  resetMapInteractions();

  tracking = true;
  trackPts = [];
  trackLine = null;
  $("#trackBar").hidden = false;
  activeTool = "track";
  highlightTool("track");
  setModeBanner("İz takibi açık");
  updateTrackLive();
  if (lastGps) appendTrackPoint(lastGps.lat, lastGps.lon);
  requestWakeLock();
  toast("İz takibi başladı");
}

function stopTrack(save) {
  if (save) {
    finishTrackSave();
    return;
  }
  tracking = false;
  trackPts = [];
  if (trackLine) {
    try {
      tempLayer.removeLayer(trackLine);
    } catch (_) {}
    trackLine = null;
  }
  $("#trackBar").hidden = true;
  if (activeTool === "track") {
    activeTool = null;
    clearToolHighlight();
  }
  setModeBanner("");
  requestWakeLock();
}

function finishTrackSave() {
  if (trackPts.length < 2) return toast("En az 2 nokta gerekli");
  const pts = trackPts.map((p) => ({ lat: p.lat, lon: p.lon }));
  const dist = trackTotalDist();
  tracking = false;
  trackPts = [];
  trackLine = null;
  $("#trackBar").hidden = true;
  activeTool = null;
  clearToolHighlight();
  setModeBanner("");
  clearTemp();
  L.polyline(
    pts.map((p) => [p.lat, p.lon]),
    { color: "#e85d4a", weight: 4 }
  ).addTo(tempLayer);
  const midPt = pts[Math.floor(pts.length / 2)];
  addMapLabel(
    tempLayer,
    midPt.lat,
    midPt.lon,
    `<span class="name">İz</span><span class="hl">${fmtDist(dist)}</span>`,
    true
  );
  pendingShape = { type: "track", pts, dist, color: "#e85d4a" };
  showResult(
    "İz",
    `<strong>Mesafe:</strong> ${fmtDist(dist)}<br/><strong>Nokta:</strong> ${pts.length}`,
    "İz"
  );
  requestWakeLock();
}

function onCenterAction() {
  const c = map.getCenter();
  const lat = c.lat;
  const lon = c.lng;

  if (pickMode || activeTool === "area") {
    onMapClick({ latlng: L.latLng(lat, lon) });
    return;
  }

  quickPoint = { lat, lon };
  $("#quickMgrs").textContent = toMgrs(lat, lon);
  openSheet("#sheetQuick");
}

function applyChromeHidden(hidden) {
  const app = $("#app");
  const topBtn = $("#btnChromeToggle");
  const fab = $("#btnChromeFab");
  const on = !!hidden;
  app.classList.toggle("chrome-hidden", on);
  if (topBtn) {
    topBtn.textContent = on ? "Göster" : "Gizle";
    topBtn.title = on ? "Alt menüyü göster" : "Alt menüyü gizle";
  }
  if (fab) {
    fab.hidden = !on;
  }
  state.settings.chromeHidden = on;
  setTimeout(() => map?.invalidateSize(), 80);
}

function toggleChrome() {
  const next = !$("#app").classList.contains("chrome-hidden");
  applyChromeHidden(next);
  persist();
  toast(next ? "Alt menü gizlendi" : "Alt menü gösterildi");
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

function syncParselSrcUi() {
  $("#parselSavedWrap").classList.toggle("hidden", $("#parselSrc").value !== "saved");
}

const TKGM_PARSEL_URL = "https://parselsorgu.tkgm.gov.tr/";

function showParselRedirect(lat, lon) {
  const la = Number(lat).toFixed(6);
  const lo = Number(lon).toFixed(6);
  const latEl = $("#parselLatVal");
  const lonEl = $("#parselLonVal");
  latEl.textContent = la;
  lonEl.textContent = lo;
  latEl.dataset.v = la;
  lonEl.dataset.v = lo;
  openSheet("#sheetParselGo");
  activeTool = null;
  clearToolHighlight();
  setModeBanner("");
  // Otomatik açma yok — kullanıcı düğmesine bassın (sistem tarayıcısı için jest gerekir)
  toast("Enlem/boylam hazır — Sistem tarayıcısında aç");
}

async function copyParselLatQuiet() {
  const la = $("#parselLatVal")?.dataset?.v;
  if (!la) return;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(la);
  } catch (_) {}
}

/** Sistem tarayıcısında aç (PWA / gömülü sekme dışında) */
function openInSystemBrowser(url) {
  const u = String(url || "").trim();
  if (!u) return;
  const ua = navigator.userAgent || "";

  if (/Android/i.test(ua)) {
    // Tam tarayıcıya çık: intent (Custom Tab / gömülü görünümü atlar)
    const hostPath = u.replace(/^https?:\/\//i, "");
    const intent =
      `intent://${hostPath}` +
      `#Intent;scheme=https;action=android.intent.action.VIEW;` +
      `category=android.intent.category.BROWSABLE;` +
      `S.browser_fallback_url=${encodeURIComponent(u)};end`;
    window.location.href = intent;
    return;
  }

  if (/iPhone|iPad|iPod/i.test(ua)) {
    // Kullanıcı jesti + _blank → Safari (standalone PWA'da gömülü açılmaz)
    const a = document.createElement("a");
    a.href = u;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }

  const w = window.open(u, "_blank", "noopener,noreferrer");
  if (!w) window.location.href = u;
}

/** TKGM sitesini sistem tarayıcısında aç */
function openTkgmInBrowser(latForClipboard) {
  const la = latForClipboard || $("#parselLatVal")?.dataset?.v;
  if (la) {
    try {
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(la);
    } catch (_) {}
  }
  openInSystemBrowser(TKGM_PARSEL_URL);
  toast("Sistem tarayıcısı açılıyor — enlem panoda");
}

async function shareTkgmLink() {
  const la = $("#parselLatVal")?.dataset?.v;
  const lo = $("#parselLonVal")?.dataset?.v;
  let text = TKGM_PARSEL_URL;
  if (la && lo) text = `TKGM Parsel Sorgu\nEnlem: ${la}\nBoylam: ${lo}\n${TKGM_PARSEL_URL}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: "TKGM Parsel Sorgu", text, url: TKGM_PARSEL_URL });
      return;
    }
  } catch (e) {
    if (e?.name === "AbortError") return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("Bağlantı panoya kopyalandı — tarayıcıda açın");
  } catch (_) {
    toast("Paylaşılamadı");
  }
}

function fmtDateTime(d = new Date()) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
}

function getItemAnchor(kind, index) {
  if (kind === "point") {
    const p = state.points[index];
    return p ? { lat: p.lat, lon: p.lon, name: p.name } : null;
  }
  if (kind === "shape") {
    const sh = state.shapes[index];
    if (!sh) return null;
    const name = sh.name || sh.type;
    if (sh.center) return { lat: sh.center.lat, lon: sh.center.lon, name };
    if (sh.pts?.length) {
      if ((sh.type === "measure" || sh.type === "bearing") && sh.pts.length >= 2) {
        const a = sh.pts[0];
        const b = sh.pts[1];
        return { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2, name };
      }
      const c = centroid(sh.pts);
      return { lat: c.lat, lon: c.lon, name };
    }
    return null;
  }
  if (kind === "draw") {
    const d = state.drawings[index];
    if (!d) return null;
    const name = d.name || "Çizim";
    if (d.labelLat != null) return { lat: d.labelLat, lon: d.labelLon, name };
    const stroke = d.strokes?.[0] || d.pts;
    if (stroke?.length) {
      const midPt = stroke[Math.floor(stroke.length / 2)];
      return { lat: midPt.lat, lon: midPt.lon, name };
    }
  }
  return null;
}

function openRouteTo(lat, lon, _name) {
  window.open(
    `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(lat + "," + lon)}`,
    "_blank",
    "noopener"
  );
}

async function shareItem(kind, index) {
  let name = "MKSI";
  let payload;
  if (kind === "point") {
    const p = state.points[index];
    if (!p) return toast("Nokta yok");
    payload = { app: "MKSI", version: 1, exportedAt: new Date().toISOString(), points: [p] };
    name = p.name || "Nokta";
  } else if (kind === "shape") {
    const s = state.shapes[index];
    if (!s) return toast("Şekil yok");
    payload = { app: "MKSI", version: 1, exportedAt: new Date().toISOString(), shapes: [s] };
    name = s.name || s.type || "Şekil";
  } else if (kind === "draw") {
    const d = state.drawings[index];
    if (!d) return toast("Çizim yok");
    payload = { app: "MKSI", version: 1, exportedAt: new Date().toISOString(), drawings: [d] };
    name = d.name || "Çizim";
  } else {
    return;
  }
  const stamp = dateStamp();
  const filename = exportFileName(name, stamp);
  const r = await shareOrDownload(filename, JSON.stringify(payload, null, 2), name);
  if (r === "shared-file") toast(`Dosya paylaşıldı: ${filename}`);
  else if (r === "download") toast(`Dosya indirildi: ${filename}`);
  else if (r !== "abort") toast("Dosya dışa aktarılamadı");
}

function dateStamp() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy}_${hh}-${mi}`;
}

function defaultLabel(sh) {
  if (sh.type === "circle") return "Daire";
  if (sh.type === "arc") return "Kavis";
  if (sh.type === "area") return "Alan";
  if (sh.type === "bearing") return "İstikamet";
  if (sh.type === "measure") return "Mesafe";
  if (sh.type === "track") return "İz";
  if (sh.type === "draw") return "Çizim";
  if (sh.type === "parsel") return sh.ozet || "Parsel";
  return "Şekil";
}

function mergeById(a, b) {
  const m = new Map(a.map((x) => [x.id, x]));
  for (const x of b) m.set(x.id || uid(), x);
  return [...m.values()];
}

function bindUi() {
  $("#btnLocate").addEventListener("click", goToLocation);
  $("#btnChromeToggle").addEventListener("click", toggleChrome);
  $("#btnChromeFab")?.addEventListener("click", toggleChrome);
  $("#btnCenterAction")?.addEventListener("click", onCenterAction);
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
        if (t === "track") stopTrack(false);
        setTool(null);
        clearTemp();
        setModeBanner("");
        clearToolHighlight();
        return;
      }
      setTool(t);
    })
  );

  $("#btnTrackCancel")?.addEventListener("click", () => stopTrack(false));
  $("#btnTrackFinish")?.addEventListener("click", () => finishTrackSave());

  $("#btnQuickMeasure")?.addEventListener("click", () => {
    if (!quickPoint) return;
    const { lat, lon } = quickPoint;
    closeSheets();
    measureKind = "measure";
    activeTool = "measure";
    highlightTool("measure");
    clearTemp();
    measurePts = [{ lat, lon }];
    L.circleMarker([lat, lon], { radius: 6, color: "#e8b84a", fillOpacity: 1 }).addTo(tempLayer);
    pickMode = "measure2";
    setModeBanner("2. noktaya dokun veya ◎");
  });
  $("#btnQuickBearing")?.addEventListener("click", () => {
    if (!quickPoint) return;
    const { lat, lon } = quickPoint;
    closeSheets();
    measureKind = "bearing";
    activeTool = "bearing";
    highlightTool("bearing");
    clearTemp();
    measurePts = [{ lat, lon }];
    L.circleMarker([lat, lon], { radius: 6, color: "#e8b84a", fillOpacity: 1 }).addTo(tempLayer);
    pickMode = "measure2";
    setModeBanner("2. noktaya dokun veya ◎");
  });
  $("#btnQuickCircle")?.addEventListener("click", () => {
    if (!quickPoint) return;
    const { lat, lon } = quickPoint;
    closeSheets();
    drawCircleAt(lat, lon);
  });
  $("#btnQuickArc")?.addEventListener("click", () => {
    if (!quickPoint) return;
    const { lat, lon } = quickPoint;
    closeSheets();
    drawArcAt(lat, lon);
  });
  $("#btnQuickArea")?.addEventListener("click", () => {
    if (!quickPoint) return;
    const { lat, lon } = quickPoint;
    closeSheets();
    activeTool = "area";
    highlightTool("area");
    areaPts = [{ lat, lon }];
    clearTemp();
    map.doubleClickZoom.disable();
    L.circleMarker([lat, lon], { radius: 5, color: "#4a9fd4", fillOpacity: 1 }).addTo(tempLayer);
    setModeBanner("1 köşe — Bitir ile tamamla");
  });
  $("#btnQuickPoint")?.addEventListener("click", () => {
    if (!quickPoint) return;
    const { lat, lon } = quickPoint;
    closeSheets();
    askName("Nokta", (name) => {
      savePointAt(lat, lon, name || "Nokta");
    });
  });
  $("#btnQuickParsel")?.addEventListener("click", () => {
    if (!quickPoint) return;
    const { lat, lon } = quickPoint;
    showParselRedirect(lat, lon);
  });
  $("#btnQuickWeather")?.addEventListener("click", () => {
    closeSheets();
    refreshWeather();
  });

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

  $("#parselSrc").addEventListener("change", syncParselSrcUi);
  $("#btnParselGo").addEventListener("click", () => {
    const src = $("#parselSrc").value;
    if (src === "cross") {
      const c = map.getCenter();
      showParselRedirect(c.lat, c.lng);
    } else if (src === "gps") {
      if (!lastGps) return toast("Konum bekleniyor…");
      showParselRedirect(lastGps.lat, lastGps.lon);
    } else if (src === "saved") {
      const p = getPointById($("#parselSavedPt").value);
      if (!p) return toast("Nokta seçin");
      showParselRedirect(p.lat, p.lon);
    } else {
      pickMode = "parsel";
      closeSheets();
      setModeBanner("Parsel için noktaya dokun");
      toast("Haritada noktaya dokunun");
    }
  });
  $("#btnParselCopyLat").addEventListener("click", () =>
    copyText($("#parselLatVal").dataset.v || $("#parselLatVal").textContent)
  );
  $("#btnParselCopyLon").addEventListener("click", () =>
    copyText($("#parselLonVal").dataset.v || $("#parselLonVal").textContent)
  );
  $("#btnParselOpen").addEventListener("click", () => {
    openTkgmInBrowser();
  });
  $("#btnParselShare")?.addEventListener("click", () => {
    shareTkgmLink();
  });

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
    if (sh.type === "area") {
      sh.color = $("#resultColor")?.value || sh.color || "#4a9fd4";
    }
    if (sh.type === "circle") sh.summary = `r=${sh.radius}m · ${fmtArea(sh.area)}`;
    else if (sh.type === "arc") sh.summary = `${sh.mainMil} · ${sh.dist}m`;
    else if (sh.type === "area") sh.summary = fmtArea(sh.area);
    else if (sh.type === "track") sh.summary = fmtDist(sh.dist);
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
    const stamp = dateStamp();
    const filename = exportFileName("MKSI", stamp);
    const r = await shareOrDownload(filename, exportJson(state, "all"), "MKSI");
    if (r === "shared-file") toast(`Dosya paylaşıldı: ${filename}`);
    else if (r === "download") toast(`Dosya indirildi: ${filename}`);
    else if (r !== "abort") toast("Dosya dışa aktarılamadı");
  });
  $("#btnExportPts").addEventListener("click", async () => {
    const stamp = dateStamp();
    const filename = exportFileName("Noktalar", stamp);
    const r = await shareOrDownload(filename, exportJson(state, "points"), "Noktalar");
    if (r === "shared-file") toast(`Dosya paylaşıldı: ${filename}`);
    else if (r === "download") toast(`Dosya indirildi: ${filename}`);
    else if (r !== "abort") toast("Dosya dışa aktarılamadı");
  });
  async function applyImportText(text) {
    const data = parseImport(text);
    if (data.points.length) state.points = mergeById(state.points, data.points);
    if (data.shapes.length) state.shapes = state.shapes.concat(data.shapes);
    if (data.drawings.length) state.drawings = state.drawings.concat(data.drawings);
    await persist();
    renderSaved();
    toast("İçe aktarıldı");
  }

  $("#btnImport").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      await applyImportText(await file.text());
    } catch (e) {
      toast("Aktarım hatası: " + e.message);
    }
    ev.target.value = "";
  });
  $("#btnImportPaste").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text?.trim()) return toast("Pano boş");
      await applyImportText(text);
    } catch (_) {
      toast("Panodan okunamadı — metni kopyalayıp tekrar deneyin");
    }
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
    const route = e.target.closest("[data-route-kind]");
    const share = e.target.closest("[data-share-kind]");
    const go = e.target.closest("[data-go-kind]");
    if (del) {
      state.points = state.points.filter((x) => x.id !== del.dataset.delPt);
      persist();
      renderSaved();
      return;
    }
    if (route) {
      const anchor = getItemAnchor(route.dataset.routeKind, Number(route.dataset.routeI));
      if (!anchor) return toast("Konum yok");
      openRouteTo(anchor.lat, anchor.lon, anchor.name);
      return;
    }
    if (share) {
      shareItem(share.dataset.shareKind, Number(share.dataset.shareI));
      return;
    }
    if (go) {
      goToItem(go.dataset.goKind, Number(go.dataset.goI));
    }
  });

  $("#shapesList").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del-kind]");
    const route = e.target.closest("[data-route-kind]");
    const share = e.target.closest("[data-share-kind]");
    const go = e.target.closest("[data-go-kind]");
    const edit = e.target.closest("[data-edit-shape]");
    if (del) {
      const i = Number(del.dataset.delI);
      if (del.dataset.delKind === "shape") state.shapes.splice(i, 1);
      else state.drawings.splice(i, 1);
      persist();
      renderSaved();
      return;
    }
    if (edit) {
      openEditShape(Number(edit.dataset.editShape));
      return;
    }
    if (route) {
      const anchor = getItemAnchor(route.dataset.routeKind, Number(route.dataset.routeI));
      if (!anchor) return toast("Konum yok");
      openRouteTo(anchor.lat, anchor.lon, anchor.name);
      return;
    }
    if (share) {
      shareItem(share.dataset.shareKind, Number(share.dataset.shareI));
      return;
    }
    if (go) {
      goToItem(go.dataset.goKind, Number(go.dataset.goI));
    }
  });

  $("#btnEditShapeSave").addEventListener("click", saveEditShape);
  $("#btnEditShapeDelete").addEventListener("click", () => {
    const index = Number($("#editShapeIndex").value);
    if (!Number.isFinite(index) || !state.shapes[index]) return;
    if (!confirm("Bu şekil silinsin mi?")) return;
    state.shapes.splice(index, 1);
    persist();
    renderSaved();
    closeSheets();
    toast("Silindi");
  });

  $("#infoMgrs").addEventListener("click", () => {
    copyText($("#infoMgrs").textContent);
  });
  $("#infoLat").addEventListener("click", () => copyText($("#infoLat").textContent));
  $("#infoLon").addEventListener("click", () => copyText($("#infoLon").textContent));

  window.addEventListener("online", setNetDot);
  window.addEventListener("offline", setNetDot);
  setNetDot();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestWakeLock();
  });

  initSwatches("#circleSwatches", "#circleColor");
  initSwatches("#arcSwatches", "#arcColor");
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
  requestWakeLock();
  const c = map.getCenter();
  updateInfo(c.lat, c.lng, { fromMap: true });
}

boot();
