## Polygon Tiles

Copy XYZ tiles that intersect a GeoJSON polygon or multipolygon.

### Usage

```
node index.js
```

You will be prompted for:

- Source tiles root (XYZ: `z/x/y.ext`)
- GeoJSON file path (Polygon or MultiPolygon)
- Min/Max zoom (default 0..15)
- Size threshold in bytes to skip tiny tiles (default 1024; set 0 to disable)
- Destination root

### Notes

- Works with `.png`, `.jpg`, `.jpeg`, `.webp`, `.pbf`, `.mvt`, `.tile`.
- Uses polygon intersection tests, so it is more accurate than a bounding box.
