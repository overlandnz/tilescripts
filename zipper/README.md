## Zipper

Chunk a tile directory into multiple zip files with a max size.

### Usage

```
node zipper.js <inputTilesDir> <outputDir> --maxMB=<N> [--ext=pbf] [--prefix=tiles] [--level=6]
node zipper.js <inputTilesDir> <outputDir> --maxBytes=<N> [--ext=pbf] [--prefix=tiles] [--level=6]
```

### Options

- `--maxMB` or `--maxBytes`: maximum zip size (required).
- `--ext`: comma-separated extensions to include (default `pbf`).
- `--prefix`: zip filename prefix (default `tiles`).
- `--level`: zip compression level 0-9 (default `6`).

### Notes

- Zips preserve relative paths like `z/x/y.pbf`.
- Chunking is based on resulting zip size (writes + shrinks if needed).
