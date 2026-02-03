## MBTiles Extract

Export vector tiles from an MBTiles database to an XYZ folder.

### Usage

```
node export-vector-mbtiles.js <input.mbtiles> <outDir> [--concurrency=32] [--logEvery=50000]
```

### Notes

- Converts TMS Y to XYZ Y.
- Automatically gunzips tile data when needed.
- Output tiles are written as `.pbf` files under `z/x/y.pbf`.
