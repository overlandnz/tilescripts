#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const fg = require("fast-glob");
const pLimit = require("p-limit");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

function usage() {
  console.log(`
Usage:
  node index.js <inputDir> --bucket=<name> [--prefix=path] [--ext=webp]
               [--region=ap-southeast-2] [--concurrency=16]
               [--contentType=image/webp] [--acl=public-read]
               [--accessKey=...] [--secretKey=...]

Examples:
  node index.js ./tiles --bucket=tiles.overlandnavigator.co.nz --prefix=202509/web/aerial --ext=webp
  node index.js ./tiles --bucket=my-bucket --prefix=tiles --ext=pbf --contentType=application/x-protobuf

Notes:
  - Keys preserve relative paths like "z/x/y.webp" under the prefix.
  - If no contentType is provided, it is inferred from file extension.
  - Credentials default to AWS environment variables if not provided.
`);
  process.exit(1);
}

function parseArg(name, def = null) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (!a) return def;
  return a.split("=").slice(1).join("=");
}

function normalizePrefix(prefix) {
  if (!prefix) return "";
  let p = prefix.replace(/\\/g, "/");
  if (p.startsWith("/")) p = p.slice(1);
  if (p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function inferContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".webp":
      return "image/webp";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".pbf":
    case ".mvt":
    case ".tile":
      return "application/x-protobuf";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) usage();

  const inputDir = path.resolve(args[0]);
  const bucket = parseArg("bucket");
  if (!bucket) usage();

  const prefix = normalizePrefix(parseArg("prefix", ""));
  const extArg = parseArg("ext", "webp");
  const exts = extArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((e) => (e.startsWith(".") ? e.slice(1) : e));
  if (!exts.length) usage();

  const region = parseArg("region", process.env.AWS_REGION || "ap-southeast-2");
  const concurrency = Math.max(1, parseInt(parseArg("concurrency", "16"), 10));
  const acl = parseArg("acl", "public-read");
  const contentTypeArg = parseArg("contentType", null);

  const accessKey = parseArg("accessKey", null);
  const secretKey = parseArg("secretKey", null);
  if ((accessKey && !secretKey) || (!accessKey && secretKey)) {
    console.error("Both --accessKey and --secretKey must be provided together.");
    process.exit(1);
  }

  if (!fs.existsSync(inputDir)) {
    console.error(`Input dir not found: ${inputDir}`);
    process.exit(2);
  }

  const globPattern = exts.length === 1
    ? `**/*.${exts[0]}`
    : `**/*.{${exts.join(",")}}`;
  const files = await fg(globPattern, { cwd: inputDir, absolute: true, onlyFiles: true });
  files.sort((a, b) => a.localeCompare(b));

  if (!files.length) {
    console.error(`No .${exts.join(", .")} files found under: ${inputDir}`);
    process.exit(3);
  }

  const client = new S3Client({
    region,
    credentials: accessKey
      ? { accessKeyId: accessKey, secretAccessKey: secretKey }
      : undefined,
  });

  console.log(`Found ${files.length.toLocaleString()} files`);
  console.log(`Bucket: ${bucket}`);
  console.log(`Prefix: ${prefix || "(none)"}`);
  console.log(`Region: ${region}`);
  console.log(`Concurrency: ${concurrency}`);

  const limit = pLimit(concurrency);
  let uploaded = 0;
  let failed = 0;

  const renderProgress = () => {
    const pct = Math.floor((uploaded / files.length) * 100);
    process.stdout.write(`\rUploaded ${uploaded}/${files.length} (${pct}%)`);
  };

  const tasks = files.map((file) =>
    limit(async () => {
      const rel = path.relative(inputDir, file).split(path.sep).join("/");
      const key = prefix ? `${prefix}/${rel}` : rel;

      const contentType = contentTypeArg || inferContentType(file);

      try {
        const command = new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: fs.createReadStream(file),
          ContentType: contentType,
          ACL: acl,
        });

        await client.send(command);
        uploaded++;
        renderProgress();
      } catch (err) {
        failed++;
        console.error(`\nError uploading ${key}: ${err.message || err}`);
      }
    })
  );

  renderProgress();
  await Promise.all(tasks);
  process.stdout.write("\n");

  console.log(`Done. Uploaded: ${uploaded.toLocaleString()}, Failed: ${failed.toLocaleString()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
