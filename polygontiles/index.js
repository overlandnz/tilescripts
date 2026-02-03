#!/usr/bin/env node
/**
 * Copy XYZ tiles within a lat/lon bounding box, skipping tiny "water" tiles.
 * Assumes structure: <source>/{z}/{x}/{y}.{ext}  (XYZ, Web Mercator)
 *
 * Prompts:
 *  - Source root
 *  - GeoJSON file with a Polygon/MultiPolygon feature
 *  - Min/Max zoom (defaults 0..15)
 *  - Size threshold in bytes to skip (default 1024; 0 disables)
 *  - Destination root
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, (ans) => resolve(ans.trim())));
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const deg2rad = (d) => d * Math.PI / 180;
const rad2deg = (r) => r * 180 / Math.PI;

// Slippy map tilenames (XYZ)
function latLonToTileXY(lat, lon, z) {
  const maxLat = 85.05112878;
  const φ = deg2rad(clamp(lat, -maxLat, maxLat));
  const n = 2 ** z;
  const x = Math.floor((lon + 180) / 360 * n);
  const y = Math.floor((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2 * n);
  return { x: clamp(x, 0, n - 1), y: clamp(y, 0, n - 1) };
}

function boundsToTileRange(bounds, z) {
  const { west, south, east, north } = bounds;
  const a = latLonToTileXY(north, west, z); // NW
  const b = latLonToTileXY(south, east, z); // SE
  const n = 2 ** z;
  let minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
  let minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  minX = clamp(minX, 0, n - 1); maxX = clamp(maxX, 0, n - 1);
  minY = clamp(minY, 0, n - 1); maxY = clamp(maxY, 0, n - 1);
  return { minX, maxX, minY, maxY };
}

function tileXToLon(x, z) {
  const n = 2 ** z;
  return x / n * 360 - 180;
}

function tileYToLat(y, z) {
  const n = 2 ** z;
  const y2 = Math.PI * (1 - 2 * y / n);
  return rad2deg(Math.atan(Math.sinh(y2)));
}

function tileXYToBounds(x, y, z) {
  const west = tileXToLon(x, z);
  const east = tileXToLon(x + 1, z);
  const north = tileYToLat(y, z);
  const south = tileYToLat(y + 1, z);
  return { west, south, east, north };
}

function walkCoords(coords, onPoint) {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    onPoint(coords[0], coords[1]);
    return;
  }
  for (const child of coords) walkCoords(child, onPoint);
}

function getPolygonData(geojson) {
  const feature = geojson.type === 'FeatureCollection'
    ? geojson.features?.find((f) => f?.geometry?.type === 'Polygon' || f?.geometry?.type === 'MultiPolygon')
    : geojson.type === 'Feature'
      ? geojson
      : { geometry: geojson };

  const geom = feature?.geometry;
  if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) {
    throw new Error('GeoJSON must contain a Polygon or MultiPolygon feature.');
  }

  const polygons = [];
  const rawPolys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of rawPolys) {
    if (!Array.isArray(poly) || poly.length === 0) continue;
    const [outer, ...holes] = poly;
    if (!outer || outer.length < 3) continue;
    polygons.push({ outer, holes });
  }

  if (polygons.length === 0) {
    throw new Error('Polygon geometry has no valid rings.');
  }

  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  walkCoords(geom.coordinates, (lon, lat) => {
    if (Number.isNaN(lon) || Number.isNaN(lat)) return;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  });

  if (![west, south, east, north].every((v) => Number.isFinite(v))) {
    throw new Error('Failed to compute bounds from GeoJSON coordinates.');
  }

  return { polygons, bounds: { west, south, east, north } };
}

function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi + 0) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  if (!pointInRing(point, polygon.outer)) return false;
  for (const hole of polygon.holes) {
    if (hole && hole.length >= 3 && pointInRing(point, hole)) return false;
  }
  return true;
}

function segmentIntersects(a, b, c, d) {
  const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const onSegment = (p, q, r) =>
    Math.min(p[0], r[0]) <= q[0] && q[0] <= Math.max(p[0], r[0]) &&
    Math.min(p[1], r[1]) <= q[1] && q[1] <= Math.max(p[1], r[1]);

  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);

  if (o1 === 0 && onSegment(a, c, b)) return true;
  if (o2 === 0 && onSegment(a, d, b)) return true;
  if (o3 === 0 && onSegment(c, a, d)) return true;
  if (o4 === 0 && onSegment(c, b, d)) return true;

  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

function polygonIntersectsBbox(polygon, bbox) {
  const { west, south, east, north } = bbox;
  const bboxCorners = [
    [west, south],
    [west, north],
    [east, north],
    [east, south],
  ];

  // Any bbox corner inside polygon
  for (const corner of bboxCorners) {
    if (pointInPolygon(corner, polygon)) return true;
  }

  // Any polygon vertex inside bbox
  for (const ring of [polygon.outer, ...polygon.holes]) {
    if (!ring) continue;
    for (const [lon, lat] of ring) {
      if (lon >= west && lon <= east && lat >= south && lat <= north) return true;
    }
  }

  // Any edge intersection
  const bboxEdges = [
    [bboxCorners[0], bboxCorners[1]],
    [bboxCorners[1], bboxCorners[2]],
    [bboxCorners[2], bboxCorners[3]],
    [bboxCorners[3], bboxCorners[0]],
  ];
  const rings = [polygon.outer, ...polygon.holes];
  for (const ring of rings) {
    if (!ring || ring.length < 2) continue;
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i];
      const b = ring[i + 1];
      for (const [c, d] of bboxEdges) {
        if (segmentIntersects(a, b, c, d)) return true;
      }
    }
  }

  return false;
}

function tileIntersectsPolygons(bbox, polygons) {
  for (const polygon of polygons) {
    if (polygonIntersectsBbox(polygon, bbox)) return true;
  }
  return false;
}

async function pathExists(p) {
  try { await fsp.access(p, fs.constants.F_OK); return true; }
  catch { return false; }
}

const CANDIDATE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.pbf', '.mvt', '.tile'];

/** Return {path, size} for the first existing tile for z/x/y, or null if none. */
async function findExistingTileFileWithSize(root, z, x, y) {
  for (const ext of CANDIDATE_EXTS) {
    const p = path.join(root, String(z), String(x), String(y) + ext);
    try {
      const st = await fsp.stat(p);
      if (st.isFile()) return { path: p, size: st.size };
    } catch {}
  }
  // Fallback: look for any file named y.*
  const dir = path.join(root, String(z), String(x));
  try {
    const files = await fsp.readdir(dir);
    const match = files.find(f => f === `${y}.png` || f === `${y}.jpg` || f.startsWith(`${y}.`));
    if (match) {
      const p = path.join(dir, match);
      const st = await fsp.stat(p);
      if (st.isFile()) return { path: p, size: st.size };
    }
  } catch {}
  return null;
}

async function ensureDir(p) { await fsp.mkdir(p, { recursive: true }); }
async function copyFileSafe(src, dest) { await ensureDir(path.dirname(dest)); await fsp.copyFile(src, dest); }
const fmtNum = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

(async () => {
  try {
    console.log('=== Copy XYZ Tiles by Lat/Lon Bounds (skip small files) ===\n');

    const sourceRoot = (await ask('Source tiles root (e.g. /data/tiles): ')) || '';
    if (!sourceRoot) throw new Error('Source root is required.');
    if (!(await pathExists(sourceRoot))) throw new Error(`Source root does not exist: ${sourceRoot}`);

    const geojsonPath = (await ask('GeoJSON file (Polygon/MultiPolygon feature): ')) || '';
    if (!geojsonPath) throw new Error('GeoJSON file is required.');
    if (!(await pathExists(geojsonPath))) throw new Error(`GeoJSON file does not exist: ${geojsonPath}`);
    const geojsonRaw = await fsp.readFile(geojsonPath, 'utf8');
    let geojson;
    try { geojson = JSON.parse(geojsonRaw); }
    catch { throw new Error('GeoJSON file is not valid JSON.'); }
    const { polygons, bounds: polygonBounds } = getPolygonData(geojson);
    const { west, south, east, north } = polygonBounds;
    if (east <= west || north <= south) throw new Error('Computed bounds are invalid (east <= west or north <= south).');

    const minZoomAns = await ask('Min zoom [0]: ');
    const maxZoomAns = await ask('Max zoom [15]: ');
    const minZoom = minZoomAns === '' ? 0 : parseInt(minZoomAns, 10);
    const maxZoom = maxZoomAns === '' ? 15 : parseInt(maxZoomAns, 10);
    if (Number.isNaN(minZoom) || Number.isNaN(maxZoom) || minZoom < 0 || maxZoom < minZoom) {
      throw new Error('Invalid zoom range.');
    }

    const sizeThresholdAns = await ask('Skip files smaller than how many bytes? [1024] (0 = disable): ');
    const sizeThreshold = sizeThresholdAns === '' ? 1024 : Math.max(0, parseInt(sizeThresholdAns, 10) || 0);

    const destRoot = (await ask('Destination root (e.g. /data/tiles-north-island): ')) || '';
    if (!destRoot) throw new Error('Destination root is required.');
    await ensureDir(destRoot);

    console.log('\nPlanning copy...');
    console.log(`  Source: ${sourceRoot}`);
    console.log(`  Dest:   ${destRoot}`);
    console.log(`  GeoJSON: ${geojsonPath}`);
    console.log(`  Bounds:  W ${west}, S ${south}, E ${east}, N ${north}`);
    console.log(`  Zooms:  ${minZoom}…${maxZoom}`);
    console.log(`  Skip <  ${sizeThreshold} bytes\n`);

    let attempted = 0, copied = 0, missing = 0, skippedSmall = 0, skippedOutside = 0;

    const CONCURRENCY = 64;
    let inFlight = 0;
    const queue = [];
    function enqueue(fn) {
      return new Promise((resolve, reject) => {
        const run = async () => {
          inFlight++;
          try { resolve(await fn()); }
          catch (e) { reject(e); }
          finally {
            inFlight--;
            if (queue.length) queue.shift()();
          }
        };
        if (inFlight < CONCURRENCY) run();
        else queue.push(run);
      });
    }

    for (let z = minZoom; z <= maxZoom; z++) {
      const { minX, maxX, minY, maxY } = boundsToTileRange(polygonBounds, z);
      const countThisZoom = (maxX - minX + 1) * (maxY - minY + 1);
      console.log(`z=${z} → x:[${minX}..${maxX}] y:[${minY}..${maxY}] ≈ ${fmtNum(countThisZoom)} tiles`);

      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          const tileBounds = tileXYToBounds(x, y, z);
          if (!tileIntersectsPolygons(tileBounds, polygons)) {
            skippedOutside++;
            continue;
          }
          attempted++;
          enqueue(async () => {
            const found = await findExistingTileFileWithSize(sourceRoot, z, x, y);
            if (!found) { missing++; return; }
            if (sizeThreshold > 0 && found.size < sizeThreshold) { skippedSmall++; return; }

            const ext = path.extname(found.path) || '.tile';
            const dest = path.join(destRoot, String(z), String(x), String(y) + ext);
            await copyFileSafe(found.path, dest);
            copied++;
          });
        }
      }
    }

    // Drain queue
    while (inFlight > 0 || queue.length > 0) {
      await new Promise(r => setTimeout(r, 50));
    }

    console.log('\nDone.');
    console.log(`  Attempted in polygon: ${fmtNum(attempted)}`);
    console.log(`  Copied:             ${fmtNum(copied)}`);
    console.log(`  Skipped (<${sizeThreshold}B): ${fmtNum(skippedSmall)}`);
    console.log(`  Skipped (outside):  ${fmtNum(skippedOutside)}`);
    console.log(`  Missing in source:  ${fmtNum(missing)}`);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
})();