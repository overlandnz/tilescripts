## Tile Server

Serve local PBF tiles with a simple Mapbox GL viewer.

### Usage

```
MAPBOX_TOKEN=your_token node index.js <path-to-tiles>
```

### Endpoints

- `http://localhost:3000/` viewer
- `http://localhost:3000/style.json`
- `http://localhost:3000/tiles/:z/:x/:y.pbf`

### Notes

- Tiles must exist at `path-to-tiles/z/x/y.pbf`.
- Requires a Mapbox token for the viewer.
