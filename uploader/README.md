## Uploader

Upload a directory of tiles/assets to S3 with a configurable prefix.

### Usage

```
node index.js <inputDir> --bucket=<name> [--prefix=path] [--ext=webp]
             [--region=ap-southeast-2] [--concurrency=16]
             [--contentType=image/webp] [--acl=public-read]
             [--accessKey=...] [--secretKey=...]
```

### Notes

- Keys preserve relative paths like `z/x/y.webp` under the prefix.
- If `--contentType` is omitted, it is inferred from file extension.
- Credentials default to AWS environment variables when not provided.
