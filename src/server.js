const { serve } = require('@hono/node-server');
const app = require('./app');

const port = Number(process.env.PORT) || 'http://localhost:3000';
console.log(`Server running at http://localhost:${port}/`);
serve({
  fetch: app.fetch,
  port,
});