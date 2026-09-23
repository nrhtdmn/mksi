/** Geo helpers — milyem (6400), MGRS, distance, area, arc */

/** Tam daire = 6400 milyem */
const MIL_FULL = 6400;

export function deg2rad(d) { return (d * Math.PI) / 180; }
export function rad2deg(r) { return (r * 180) / Math.PI; }

export function degToMil(deg) {
  let m = (deg * MIL_FULL) / 360;
  m = ((m % MIL_FULL) + MIL_FULL) % MIL_FULL;
  return Math.round(m);
}

export function milToDeg(mil) {
  return (mil * 360) / MIL_FULL;
}

/** Normalize mils to 0..6399 */
export function normMil(m) {
  return ((Math.round(m) % MIL_FULL) + MIL_FULL) % MIL_FULL;
}

/** Haversine distance in meters */
export function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = deg2rad(lat1);
  const φ2 = deg2rad(lat2);
  const Δφ = deg2rad(lat2 - lat1);
  const Δλ = deg2rad(lon2 - lon1);
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Forward azimuth degrees (0=N, clockwise) from p1 to p2 */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = deg2rad(lat1);
  const φ2 = deg2rad(lat2);
  const Δλ = deg2rad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (rad2deg(Math.atan2(y, x)) + 360) % 360;
}

export function bearingMil(lat1, lon1, lat2, lon2) {
  return degToMil(bearingDeg(lat1, lon1, lat2, lon2));
}

/** Destination point given start, mils bearing, distance m */
export function destination(lat, lon, mils, distM) {
  const R = 6371000;
  const δ = distM / R;
  const θ = deg2rad(milToDeg(mils));
  const φ1 = deg2rad(lat);
  const λ1 = deg2rad(lon);
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
    );
  return { lat: rad2deg(φ2), lon: ((rad2deg(λ2) + 540) % 360) - 180 };
}

/** Arc polyline: center, main mils, dist, left offset mils, right offset mils */
export function arcPoints(lat, lon, mainMil, distM, leftHudut, rightHudut, steps = 48) {
  const start = normMil(mainMil - leftHudut);
  const end = normMil(mainMil + rightHudut);
  let span = rightHudut + leftHudut;
  if (span <= 0) span = 1;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const mil = normMil(start + (span * i) / steps);
    pts.push(destination(lat, lon, mil, distM));
  }
  return { pts, startMil: start, endMil: end, mainMil: normMil(mainMil) };
}

/** Format distance */
export function fmtDist(m) {
  if (m == null || Number.isNaN(m)) return "—";
  if (m < 1000) return `${m.toFixed(1)} m`;
  return `${(m / 1000).toFixed(3)} km`;
}

/** Format area m2 */
export function fmtArea(m2) {
  if (m2 == null || Number.isNaN(m2)) return "—";
  if (m2 < 10000) return `${m2.toFixed(1)} m²`;
  if (m2 < 1e6) return `${(m2 / 10000).toFixed(3)} ha`;
  return `${(m2 / 1e6).toFixed(3)} km²`;
}

/** Circle area */
export function circleArea(r) {
  return Math.PI * r * r;
}

/** Spherical polygon area (m2) — pts [{lat,lon}] closed or open */
export function polygonArea(pts) {
  if (!pts || pts.length < 3) return 0;
  const R = 6371000;
  const ring = pts.slice();
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first.lat !== last.lat || first.lon !== last.lon) ring.push({ ...first });
  let total = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const p1 = ring[i];
    const p2 = ring[i + 1];
    total +=
      deg2rad(p2.lon - p1.lon) *
      (2 + Math.sin(deg2rad(p1.lat)) + Math.sin(deg2rad(p2.lat)));
  }
  return Math.abs((total * R * R) / 2);
}

/** Approximate slope % from center elev and nearby sample elevs (m) */
export function slopePercent(centerElev, samples) {
  // samples: [{distM, elev}]
  if (centerElev == null || !samples?.length) return null;
  let max = 0;
  for (const s of samples) {
    if (s.elev == null || !s.distM) continue;
    const g = (Math.abs(s.elev - centerElev) / s.distM) * 100;
    if (g > max) max = g;
  }
  return max;
}

export function fmtCoord(lat, lon, digits = 6) {
  if (lat == null || lon == null) return "—";
  return `${lat.toFixed(digits)}, ${lon.toFixed(digits)}`;
}
