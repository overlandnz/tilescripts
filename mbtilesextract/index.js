#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const Database = require("better-sqlite3");
const pLimit = require("p-limit");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function tmsToXyzY(z, tmsY) {
  return (1 << z) - 1 - tmsY;
}

function isGzip(buf) {
  return buf && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log(`Usage:
  node export-vector-mbtiles.js <input.mbtiles> <outDir> [--concurrency=32] [--logEvery=50000]
`);
    process.exit(1);
  }

  const input = args[0];
  const outDir = args[1];

  const concArg = args.find((a) => a.startsWith("--concurrency="));
  const concurrency = concArg ? Math.max(1, parseInt(concArg.split("=")[1], 10)) : 24;

  const logArg = args.find((a) => a.startsWith("--logEvery="));
  const logEvery = logArg ? Math.max(1000, parseInt(logArg.split("=")[1], 10)) : 50000;

  if (!fs.existsSync(input)) {
    console.error(`Input not found: ${input}`);
    process.exit(2);
  }
  ensureDir(outDir);

  const db = new Database(input, { readonly: true });

  // Optional metadata peek
  try {
    const fmt = db.prepare(`SELECT value FROM metadata WHERE name='format'`).get()?.value;
    const type = db.prepare(`SELECT value FROM metadata WHERE name='type'`).get()?.value;
    if (fmt) console.log(`metadata.format = ${fmt}`);
    if (type) console.log(`metadata.type   = ${type}`);
  } catch {
    // ignore
  }

  // Helpful for speed with big DBs
  db.pragma("cache_size = -200000"); // ~200MB cache (negative => KB units)
  db.pragma("journal_mode = OFF");
  db.pragma("synchronous = OFF");

  const stmt = db.prepare(`
    SELECT zoom_level AS z, tile_column AS x, tile_row AS y, tile_data AS data
    FROM tiles
  `);

  const limit = pLimit(concurrency);

  let processed = 0;
  let written = 0;
  let gunzipped = 0;

  const pending = [];
  const start = Date.now();

  for (const r of stmt.iterate()) {
    processed++;

    pending.push(
      limit(async () => {
        const z = r.z;
        const x = r.x;
        const xyzY = tmsToXyzY(z, r.y);

        const dir = path.join(outDir, String(z), String(x));
        ensureDir(dir);

        const outPath = path.join(dir, `${xyzY}.pbf`);

        let outBuf;
        if (isGzip(r.data)) {
          outBuf = zlib.gunzipSync(r.data);
          gunzipped++;
        } else {
          outBuf = r.data;
        }

        await fs.promises.writeFile(outPath, outBuf);
        written++;
      })
    );

    // Backpressure: flush periodically so we don't build up huge promise arrays
    if (pending.length >= concurrency * 300) {
      await Promise.all(pending.splice(0));
    }

    if (processed % logEvery === 0) {
      const secs = (Date.now() - start) / 1000;
      const rate = Math.round(processed / Math.max(1, secs));
      console.log(
        `Processed ${processed.toLocaleString()} | written ${written.toLocaleString()} | gunzipped ${gunzipped.toLocaleString()} | ~${rate.toLocaleString()}/sec`
      );
    }
  }

  if (pending.length) await Promise.all(pending);

  db.close();

  const secs = (Date.now() - start) / 1000;
  console.log(`Done.`);
  console.log(`Tiles processed: ${processed.toLocaleString()}`);
  console.log(`Tiles written:   ${written.toLocaleString()}`);
  console.log(`Gunzipped tiles: ${gunzipped.toLocaleString()}`);
  console.log(`Elapsed:         ${secs.toFixed(1)}s`);
  console.log(`Output:          ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});