#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const fg = require("fast-glob");

function usage() {
  console.log(`
Usage:
  node zipper.js <inputTilesDir> <outputDir> --maxMB=<N> [--ext=pbf] [--prefix=tiles] [--level=6]
  node zipper.js <inputTilesDir> <outputDir> --maxBytes=<N> [--ext=pbf] [--prefix=tiles] [--level=6]

Examples:
  node zipper.js ./tiles ./zips --maxMB=250 --ext=pbf --prefix=topo --level=6
  node zipper.js ./tiles ./zips --maxBytes=262144000 --ext=pbf --prefix=topo --level=6
  node zipper.js ./tiles ./zips --maxMB=250 --ext=pbf,mvt --prefix=topo --level=6

Notes:
  - Zips contain relative paths like "z/x/y.pbf"
  - Chunking is by resulting ZIP size (written to disk), using retry + binary search
`);
  process.exit(1);
}

function parseArg(name, def = null) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (!a) return def;
  return a.split("=").slice(1).join("=");
}

async function fileExists(p) {
  try {
    await fs.promises.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function safeUnlink(p) {
  try {
    await fs.promises.unlink(p);
  } catch {}
}

async function createZip(zipPath, filesAbs, baseDir, level) {
  await fs.promises.mkdir(path.dirname(zipPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level } });

    output.on("close", () => resolve(archive.pointer())); // bytes written
    output.on("error", reject);

    archive.on("warning", (err) => {
      // non-fatal warnings can happen on stat errors etc
      console.warn("archive warning:", err);
    });
    archive.on("error", reject);

    archive.pipe(output);

    for (const abs of filesAbs) {
      const rel = path.relative(baseDir, abs).replaceAll(path.sep, "/");
      archive.file(abs, { name: rel });
    }

    archive.finalize();
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) usage();

  const inputDir = path.resolve(args[0]);
  const outputDir = path.resolve(args[1]);

  const maxMB = parseArg("maxMB");
  const maxBytesArg = parseArg("maxBytes");
  if (!maxMB && !maxBytesArg) usage();

  const maxZipBytes = maxBytesArg
    ? Math.max(1, parseInt(maxBytesArg, 10))
    : Math.max(1, Math.floor(parseFloat(maxMB) * 1024 * 1024));

  const prefix = parseArg("prefix", "tiles");
  const extArg = parseArg("ext", "pbf");
  const exts = extArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((e) => (e.startsWith(".") ? e.slice(1) : e));
  if (!exts.length) usage();
  const level = Math.min(9, Math.max(0, parseInt(parseArg("level", "6"), 10)));

  if (!fs.existsSync(inputDir)) {
    console.error(`Input dir not found: ${inputDir}`);
    process.exit(2);
  }
  await fs.promises.mkdir(outputDir, { recursive: true });

  // Find all matching files under inputDir
  const globPattern = exts.length === 1
    ? `**/*.${exts[0]}`
    : `**/*.{${exts.join(",")}}`;
  const files = await fg(globPattern, { cwd: inputDir, absolute: true, onlyFiles: true });
  if (!files.length) {
    console.error(`No .${exts.join(", .")} files found under: ${inputDir}`);
    process.exit(3);
  }

  // Deterministic ordering
  files.sort((a, b) => a.localeCompare(b));

  // Pre-stat sizes (uncompressed) for initial chunk guesses
  const sizes = new Array(files.length);
  let totalUncompressed = 0;
  for (let i = 0; i < files.length; i++) {
    const s = fs.statSync(files[i]).size;
    sizes[i] = s;
    totalUncompressed += s;
  }

  console.log(`Found ${files.length.toLocaleString()} .${exts.join(", .")} files`);
  console.log(`Total uncompressed size: ${(totalUncompressed / (1024 * 1024)).toFixed(1)} MB`);
  console.log(`Max zip size: ${(maxZipBytes / (1024 * 1024)).toFixed(1)} MB`);
  console.log(`Compression level: ${level}`);
  console.log(`Output: ${outputDir}`);

  let zipIndex = 1;
  let i = 0;

  while (i < files.length) {
    // First guess: take as many files as possible where uncompressed sum <= maxZipBytes.
    // (Zip is usually smaller, but we’ll verify and shrink if needed.)
    let j = i;
    let sum = 0;
    while (j < files.length && sum + sizes[j] <= maxZipBytes) {
      sum += sizes[j];
      j++;
    }
    if (j === i) j = i + 1; // at least one file

    const zipName = `${prefix}-${String(zipIndex).padStart(4, "0")}.zip`;
    const finalZipPath = path.join(outputDir, zipName);
    const tmpZipPath = finalZipPath + ".partial";

    // Binary search shrink-to-fit if needed
    let lo = i + 1;
    let hi = j;
    let bestJ = null;
    let bestBytes = null;

    // Try the initial guess first
    await safeUnlink(tmpZipPath);
    const initialBytes = await createZip(tmpZipPath, files.slice(i, j), inputDir, level);

    if (initialBytes <= maxZipBytes) {
      bestJ = j;
      bestBytes = initialBytes;
    } else {
      // If a single file already exceeds, we can’t do much—warn and accept oversize.
      if (j === i + 1) {
        console.warn(
          `WARNING: single tile zip exceeds max (${(initialBytes / (1024 * 1024)).toFixed(
            1
          )}MB > ${(maxZipBytes / (1024 * 1024)).toFixed(1)}MB). Keeping it anyway: ${zipName}`
        );
        bestJ = j;
        bestBytes = initialBytes;
      } else {
        // Shrink with binary search; we want the largest chunk that fits.
        await safeUnlink(tmpZipPath);

        hi = j - 1; // since j failed, start below
        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2);

          await safeUnlink(tmpZipPath);
          const midBytes = await createZip(tmpZipPath, files.slice(i, mid), inputDir, level);

          if (midBytes <= maxZipBytes) {
            bestJ = mid;
            bestBytes = midBytes;
            lo = mid + 1; // try bigger
          } else {
            hi = mid - 1; // try smaller
          }
        }

        // If nothing fit (should be rare), fall back to single file
        if (bestJ == null) {
          const one = i + 1;
          await safeUnlink(tmpZipPath);
          const oneBytes = await createZip(tmpZipPath, files.slice(i, one), inputDir, level);
          console.warn(
            `WARNING: could not fit any multi-file chunk under max; using single file. Zip size ${(oneBytes /
              (1024 * 1024)).toFixed(1)}MB`
          );
          bestJ = one;
          bestBytes = oneBytes;
        }
      }
    }

    // Ensure tmpZipPath exists for bestJ; if best was initial, it already exists.
    // If bestJ differs from initial j, the last binary-search attempt already created it at tmpZipPath.
    // But if initial was accepted, tmpZipPath is correct. If bestJ is initial+accepted, ok.
    // If bestJ is initial+1 oversize warning, ok.
    // If bestJ differs and last attempt created it, ok.

    // In some edge cases, tmpZipPath might be missing (shouldn’t happen). Rebuild just in case.
    if (!(await fileExists(tmpZipPath))) {
      const rebuilt = await createZip(tmpZipPath, files.slice(i, bestJ), inputDir, level);
      bestBytes = rebuilt;
    }

    // Move into place
    await fs.promises.rename(tmpZipPath, finalZipPath);

    console.log(
      `Created ${zipName}: files=${(bestJ - i).toLocaleString()} ` +
        `zipSize=${(bestBytes / (1024 * 1024)).toFixed(1)}MB ` +
        `range=[${i.toLocaleString()}..${(bestJ - 1).toLocaleString()}]`
    );

    i = bestJ;
    zipIndex++;
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});