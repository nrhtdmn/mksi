/** TKGM MEGSIS parsel sorgu (halka açık CBS API). Malik bilgisi yok. */

const BASE = "https://cbsapi.tkgm.gov.tr/megsiswebapi.v3.1/api";

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TKGM ${res.status}`);
  return res.json();
}

/** İl listesi → [{ id, text }] */
export async function fetchIller() {
  const data = await getJson("/idariYapi/ilListe");
  const feats = data?.features || [];
  return feats
    .map((f) => ({
      id: f.properties?.id ?? f.id,
      text: f.properties?.text || f.properties?.adi || f.properties?.name || "",
    }))
    .filter((x) => x.id != null && x.text)
    .sort((a, b) => a.text.localeCompare(b.text, "tr"));
}

export async function fetchIlceler(ilId) {
  const data = await getJson(`/idariYapi/ilceListe/${ilId}`);
  const feats = data?.features || [];
  return feats
    .map((f) => ({
      id: f.properties?.id ?? f.id,
      text: f.properties?.text || f.properties?.adi || "",
    }))
    .filter((x) => x.id != null && x.text)
    .sort((a, b) => a.text.localeCompare(b.text, "tr"));
}

export async function fetchMahalleler(ilceId) {
  const data = await getJson(`/idariYapi/mahalleListe/${ilceId}`);
  const feats = data?.features || [];
  return feats
    .map((f) => ({
      id: f.properties?.id ?? f.id,
      text: f.properties?.text || f.properties?.adi || "",
    }))
    .filter((x) => x.id != null && x.text)
    .sort((a, b) => a.text.localeCompare(b.text, "tr"));
}

/** Koordinat ile parsel (GeoJSON Feature veya null) */
export async function fetchParselByCoord(lat, lon) {
  return getJson(`/parsel/${lat}/${lon}/`);
}

/** Mahalle + ada + parsel */
export async function fetchParselByAda(mahalleId, ada, parsel) {
  const a = encodeURIComponent(String(ada).trim());
  const p = encodeURIComponent(String(parsel).trim());
  return getJson(`/parsel/${mahalleId}/${a}/${p}`);
}

/** GeoJSON ring [lon,lat][] → [{lat,lon}] */
export function ringToLatLngs(coords) {
  if (!coords?.length) return [];
  let ring = coords;
  if (Array.isArray(coords[0]) && Array.isArray(coords[0][0])) {
    ring = coords[0]; // Polygon
  }
  if (Array.isArray(coords[0]?.[0]?.[0])) {
    ring = coords[0][0]; // MultiPolygon first
  }
  return ring.map(([lon, lat]) => ({ lat, lon }));
}

export function featureCenter(feature) {
  const pts = ringToLatLngs(feature?.geometry?.coordinates);
  if (!pts.length) return null;
  let lat = 0;
  let lon = 0;
  for (const p of pts) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: lat / pts.length, lon: lon / pts.length };
}

export function summarizeParsel(props) {
  if (!props) return "";
  const ada = props.adaNo ?? props.ada ?? "";
  const no = props.parselNo ?? props.parsel ?? "";
  const alan = props.alan || "";
  const nit = props.nitelik || "";
  const mah = props.mahalleAd || "";
  const il = props.ilAd || "";
  const ilce = props.ilceAd || "";
  return {
    title: props.ozet || `${mah}-${ada}/${no}`,
    ada,
    parsel: no,
    alan,
    nitelik: nit,
    mahalle: mah,
    il,
    ilce,
    pafta: props.pafta || "",
    mevkii: props.mevkii || "",
    html:
      `<strong>${escape(props.ozet || `${mah} ${ada}/${no}`)}</strong><br/>` +
      `${escape(il)} / ${escape(ilce)} / ${escape(mah)}<br/>` +
      `<strong>Ada/Parsel:</strong> ${escape(String(ada))}/${escape(String(no))}<br/>` +
      `<strong>Alan:</strong> ${escape(String(alan))} m²<br/>` +
      `<strong>Nitelik:</strong> ${escape(nit)}` +
      (props.pafta ? `<br/><strong>Pafta:</strong> ${escape(props.pafta)}` : "") +
      (props.mevkii ? `<br/><strong>Mevkii:</strong> ${escape(props.mevkii)}` : ""),
  };
}

function escape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export const TKGM_SITE = "https://parselsorgu.tkgm.gov.tr/";
