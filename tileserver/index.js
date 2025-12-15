const fastify = require('fastify')({ logger: true })
const fs = require('fs')

const tilesPath = process.argv[2]
const mapboxToken = process.env.MAPBOX_TOKEN

if (!tilesPath) {
    console.error("Usage: node index.js <path-to-tiles>");
    process.exit(1);
}

if (!mapboxToken) {
    console.error("Error: MAPBOX_TOKEN environment variable is not set.");
    process.exit(1);
}

fastify.get('/', function handler(request, reply) {
    const indexPath = `${__dirname}/index.html`
    fastify.log.info(`Serving index file: ${indexPath}`)

    const stream = fs.createReadStream(indexPath)
    stream.on('error', (err) => {
        fastify.log.error(`Error reading index file: ${err}`)
        reply.code(500).send('Internal Server Error')
    });

// Get the contents of the index.html file and replace the placeholder with the actual Mapbox token
    let data = '';
    stream.on('data', chunk => {
        data += chunk;
    });
    stream.on('end', () => {
        data = data.replace('{{MAPBOX_TOKEN}}', mapboxToken);
        reply.type('text/html').send(data);
    });
})

fastify.get('/tiles/:z/:x/:y.pbf', async (request, reply) => {
  const { z, x, y } = request.params;

  const tilePath = `${tilesPath}/${z}/${x}/${y}.pbf`;
  fastify.log.info(`Request for tile: ${tilePath}`);

  reply.header('Content-Type', 'application/x-protobuf');
  reply.header('Access-Control-Allow-Origin', '*'); // dev only; lock down later

  const stream = fs.createReadStream(tilePath);
  stream.on('error', (err) => {
    fastify.log.error(`Error reading tile: ${err}`);
    reply.code(404).send('Tile not found');
  });

  return reply.send(stream);
});

fastify.get('/style.json', function handler(request, reply) {
    const stylePath = `${__dirname}/style.json`
    fastify.log.info(`Serving style file: ${stylePath}`)
    console.log(`Serving style file: ${stylePath}`)

    const stream = fs.createReadStream(stylePath)
    stream.on('error', (err) => {
        fastify.log.error(`Error reading style file: ${err}`)
        reply.code(500).send('Internal Server Error')
    });
    stream.pipe(reply.raw)
})

fastify.register(require('@fastify/compress'), {
  global: true,
  encodings: ['gzip']
});

// Run the server!
fastify.listen({ port: 3000 }, (err) => {
    if (err) {
        fastify.log.error(err)
        process.exit(1)
    }
})