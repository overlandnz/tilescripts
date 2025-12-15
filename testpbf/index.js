const fs = require("fs");
const Pbf = require("pbf").default;
const { VectorTile } = require("@mapbox/vector-tile");

const file = process.argv[2];
const buf = fs.readFileSync(file);

const tile = new VectorTile(new Pbf(buf));

console.log("Layers:", Object.keys(tile.layers));
for (const name of Object.keys(tile.layers)) {
  const layer = tile.layers[name];
  console.log(`- ${name}: features=${layer.length}, version=${layer.version}`);
}