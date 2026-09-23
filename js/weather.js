/** Open-Meteo weather + elevation (online only; cached in memory) */

const elevCache = new Map();
const weatherCache = new Map();

function key(lat, lon, p = 3) {
  return `${lat.toFixed(p)},${lon.toFixed(p)}`;
}

export async function getElevation(lat, lon) {
  const k = key(lat, lon, 4);
  if (elevCache.has(k)) return elevCache.get(k);
  if (!navigator.onLine) return null;
  try {
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const elev = data?.elevation?.[0] ?? null;
    if (elev != null) elevCache.set(k, elev);
    return elev;
  } catch {
    return null;
  }
}

/** Sample elevations around point for slope */
export async function getSlopeNear(lat, lon, distM = 50) {
  const center = await getElevation(lat, lon);
  if (center == null) return { elev: null, slope: null };
  const offsets = [
    [distM, 0],
    [-distM, 0],
    [0, distM],
    [0, -distM],
  ];
  const R = 6371000;
  const samples = [];
  for (const [dn, de] of offsets) {
    const dLat = (dn / R) * (180 / Math.PI);
    const dLon = (de / (R * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
    const e = await getElevation(lat + dLat, lon + dLon);
    if (e != null) samples.push({ distM, elev: e });
  }
  let slope = null;
  if (samples.length) {
    let max = 0;
    for (const s of samples) {
      const g = (Math.abs(s.elev - center) / s.distM) * 100;
      if (g > max) max = g;
    }
    slope = max;
  }
  return { elev: center, slope };
}

export async function getWeather(lat, lon) {
  const k = key(lat, lon, 2);
  const hit = weatherCache.get(k);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.data;
  if (!navigator.onLine) return hit?.data ?? null;
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m` +
      `&wind_speed_unit=ms&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const c = data.current;
    if (!c) return null;
    const out = {
      temp: c.temperature_2m,
      humidity: c.relative_humidity_2m,
      wind: c.wind_speed_10m,
      windDir: c.wind_direction_10m,
      code: c.weather_code,
      desc: weatherCodeTr(c.weather_code),
    };
    weatherCache.set(k, { t: Date.now(), data: out });
    return out;
  } catch {
    return null;
  }
}

function weatherCodeTr(code) {
  const map = {
    0: "Açık",
    1: "Çoğunlukla açık",
    2: "Parçalı bulutlu",
    3: "Kapalı",
    45: "Sis",
    48: "Kırağılı sis",
    51: "Hafif çisenti",
    53: "Çisenti",
    55: "Şiddetli çisenti",
    61: "Hafif yağmur",
    63: "Yağmur",
    65: "Şiddetli yağmur",
    71: "Hafif kar",
    73: "Kar",
    75: "Şiddetli kar",
    80: "Sağanak",
    81: "Sağanak",
    82: "Şiddetli sağanak",
    95: "Gök gürültülü",
    96: "Dolu",
    99: "Şiddetli dolu",
  };
  return map[code] ?? `Kod ${code}`;
}
