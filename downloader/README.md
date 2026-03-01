## Downloader

Download LINZ basemap tiles listed in a JSON file.

### Usage

```
node index.js --tiles <path> --output <dir> --apikey <key> --tileType <type> [--threads 4]
```

### Required

- `--tiles`: path to JSON file of tiles to download
- `--output`: output directory for tiles
- `--apikey`: LINZ API key
- `--tileType`: tile set name (e.g. `topo-raster`)

### Optional

- `--threads`: concurrent downloads (default `4`)

### Notes

- Tiles are saved as `.webp` under `output/z/x/y.webp`.
