/** Local persistence — IndexedDB + localStorage fallback. No remote sync. */

const DB_NAME = "mksi-map";
const DB_VER = 1;
const STORE = "data";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const KEY = "mksi-state-v1";

const defaultState = () => ({
  points: [],
  drawings: [],
  shapes: [],
  settings: { layer: "hybrid", lastLat: 39.92, lastLon: 32.85, lastZoom: 12 },
});

export async function loadState() {
  try {
    const fromIdb = await idbGet(KEY);
    if (fromIdb) return { ...defaultState(), ...fromIdb };
  } catch (_) {}
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaultState(), ...JSON.parse(raw) };
  } catch (_) {}
  return defaultState();
}

export async function saveState(state) {
  const payload = {
    points: state.points || [],
    drawings: state.drawings || [],
    shapes: state.shapes || [],
    settings: state.settings || defaultState().settings,
    savedAt: new Date().toISOString(),
  };
  try {
    await idbSet(KEY, payload);
  } catch (_) {}
  try {
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch (_) {}
  return payload;
}

export function exportJson(state, filter = "all") {
  const all = {
    app: "MKSI",
    version: 1,
    exportedAt: new Date().toISOString(),
    points: state.points || [],
    drawings: state.drawings || [],
    shapes: state.shapes || [],
    settings: state.settings || {},
  };
  if (filter === "points") {
    return JSON.stringify({ app: all.app, version: 1, exportedAt: all.exportedAt, points: all.points }, null, 2);
  }
  if (filter === "shapes") {
    return JSON.stringify(
      { app: all.app, version: 1, exportedAt: all.exportedAt, shapes: all.shapes, drawings: all.drawings },
      null,
      2
    );
  }
  return JSON.stringify(all, null, 2);
}

export function parseImport(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== "object") throw new Error("Geçersiz dosya");
  return {
    points: Array.isArray(data.points) ? data.points : [],
    drawings: Array.isArray(data.drawings) ? data.drawings : [],
    shapes: Array.isArray(data.shapes) ? data.shapes : [],
    settings: data.settings && typeof data.settings === "object" ? data.settings : null,
  };
}

export async function shareOrDownload(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const file = new File([blob], filename, { type: "application/json" });
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: "MKSI veri", text: "MKSI harita verisi" });
    return "shared";
  }
  if (navigator.share) {
    try {
      await navigator.share({ title: "MKSI veri", text });
      return "shared-text";
    } catch (e) {
      if (e.name === "AbortError") return "abort";
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return "download";
}
