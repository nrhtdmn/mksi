/** Local persistence — IndexedDB + localStorage. No remote sync. */

const DB_NAME = "mksi-map";
const DB_VER = 1;
const STORE = "data";
const KEY = "mksi-state-v1";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
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

const defaultState = () => ({
  points: [],
  drawings: [],
  shapes: [],
  settings: { layer: "hybrid", lastLat: 39.92, lastLon: 32.85, lastZoom: 12, chromeHidden: false },
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
    return JSON.stringify(
      { app: all.app, version: 1, exportedAt: all.exportedAt, points: all.points },
      null,
      2
    );
  }
  if (filter === "shapes") {
    return JSON.stringify(
      {
        app: all.app,
        version: 1,
        exportedAt: all.exportedAt,
        shapes: all.shapes,
        drawings: all.drawings,
      },
      null,
      2
    );
  }
  return JSON.stringify(all, null, 2);
}

export function parseImport(text) {
  let raw = String(text || "").trim();
  // WhatsApp / paylaşım metninden JSON bloğunu çıkar
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  const brace = raw.indexOf("{");
  if (brace > 0) raw = raw.slice(brace);
  const data = JSON.parse(raw);
  if (!data || typeof data !== "object") throw new Error("Geçersiz dosya");
  return {
    points: Array.isArray(data.points) ? data.points : [],
    drawings: Array.isArray(data.drawings) ? data.drawings : [],
    shapes: Array.isArray(data.shapes) ? data.shapes : [],
    settings: data.settings && typeof data.settings === "object" ? data.settings : null,
  };
}

/** Dosya indir + paylaşım paneli (WhatsApp / Bip ek olarak) */
export async function shareOrDownload(filename, text, title = "MKSI") {
  const body = String(text);
  const safeName = String(filename || "mksi.json").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  const blob = new Blob([body], { type: "application/json;charset=utf-8" });

  // 1) Her zaman dosyayı indir
  let downloaded = false;
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = safeName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    downloaded = true;
  } catch (_) {}

  // 2) Paylaşım paneli — ek olarak gönderilebilsin
  if (navigator.share) {
    try {
      let file = new File([blob], safeName, { type: "application/json" });
      if (!navigator.canShare?.({ files: [file] })) {
        // WhatsApp / Bip çoğu cihazda text/plain ekini kabul eder
        const txtName = safeName.replace(/\.json$/i, ".txt");
        file = new File([body], txtName, { type: "text/plain" });
      }
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title, text: title });
        return downloaded ? "download+shared" : "shared-file";
      }
      await navigator.share({
        title,
        text: `${title}\n\n${safeName} indirildi. İçe aktarmak için dosyayı kullanın.`,
      });
      return downloaded ? "download+shared" : "shared";
    } catch (e) {
      if (e?.name === "AbortError") return downloaded ? "download" : "abort";
    }
  }

  return downloaded ? "download" : "fail";
}

/** Dosya adı: şekil/çizim adı + tarih saat */
export function exportFileName(itemName, stamp) {
  const base = String(itemName || "MKSI")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/[. ]+$/g, "")
    .slice(0, 80) || "MKSI";
  return `${base}-${stamp}.json`;
}
