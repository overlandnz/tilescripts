const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');

// Helper function for user input
const prompt = (query) =>
    new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        rl.question(query, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
function parseArgs(argv) {
    const args = {
        tilesPath: null,
        outputDir: null,
        threads: null,
        apiKey: null,
        tileType: null,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--tiles') {
            args.tilesPath = argv[i + 1];
            i += 1;
        } else if (arg === '--threads') {
            args.threads = argv[i + 1];
            i += 1;
        } else if (arg === '--output') {
            args.outputDir = argv[i + 1];
            i += 1;
        } else if (arg === '--apikey') {
            args.apiKey = argv[i + 1];
            i += 1;
        } else if (arg === '--tileType') {
            args.tileType = argv[i + 1];
            i += 1;
        }
    }

    return args;
}

async function main() {
    const { tilesPath, outputDir, threads, apiKey, tileType } = parseArgs(process.argv.slice(2));

    if (!tilesPath) {
        console.error('Missing required parameter: --tiles <path>');
        process.exit(1);
    }
    const resolvedTilesPath = tilesPath;
    const tiles = JSON.parse(fs.readFileSync(resolvedTilesPath));

    if (!apiKey) {
        console.error('Missing required parameter: --apikey <key>');
        process.exit(1);
    }
    if (!tileType) {
        console.error('Missing required parameter: --tileType <type>');
        process.exit(1);
    }
    const API_KEY = apiKey;
    const TILE_TYPE = tileType;
    // URL template
    const TILE_URL_TEMPLATE = 'https://basemaps.linz.govt.nz/v1/tiles/{TYPE}/WebMercatorQuad/{z}/{x}/{y}.webp?api={APIKEY}';

    if (!outputDir) {
        console.error('Missing required parameter: --output <dir>');
        process.exit(1);
    }
    const OUTPUT_DIR = outputDir;
    const concurrencyInput = threads;
    const CONCURRENCY = Math.max(1, Number.parseInt(concurrencyInput, 10) || 4);

    // Function to create a directory if it doesn't exist
    function ensureDirectoryExists(dir) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    // Function to download a single tile
    function downloadTile(z, x, y) {
        const url = TILE_URL_TEMPLATE.replace('{z}', z)
            .replace('{x}', x)
            .replace('{y}', y)
            .replace('{TYPE}', TILE_TYPE)
            .replace('{APIKEY}', API_KEY);

        const tileDir = path.join(OUTPUT_DIR, z, x);
        const filePath = path.join(tileDir, `${y}.webp`);

        ensureDirectoryExists(tileDir); // Ensure the directory exists

        return new Promise((resolve, reject) => {
            https.get(url, (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download ${url}: ${response.statusCode}`));
                    return;
                }
                const fileStream = fs.createWriteStream(filePath);
                response.pipe(fileStream);
                fileStream.on('finish', () => {
                    fileStream.close();
                    console.log(`Downloaded: ${filePath}`);
                    resolve();
                });
            }).on('error', (err) => {
                reject(err);
            });
        });
    }

    // Function to process the JSON and download tiles
    async function downloadTiles(tiles) {
        try {
            const tasks = [];
            for (const z in tiles) {
                for (const x in tiles[z]) {
                    for (const y of tiles[z][x]) {
                        tasks.push(() => downloadTile(z, x, y));
                    }
                }
            }

            let cursor = 0;
            async function runNext() {
                if (cursor >= tasks.length) {
                    return;
                }
                const task = tasks[cursor];
                cursor += 1;
                await task();
                await runNext();
            }

            const workers = Array.from(
                { length: Math.min(CONCURRENCY, tasks.length) },
                () => runNext(),
            );
            await Promise.all(workers);
            console.log('All tiles downloaded successfully.');
        } catch (err) {
            console.error('Error downloading tiles:', err);
        }
    }

    // Start downloading
    downloadTiles(tiles);
}

// Execute the main function
main();