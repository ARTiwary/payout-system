const express = require('express');
const { createContainer } = require('./container');
const { buildRouter } = require('./controllers/routes');

function createApp(options = {}) {
  const app = express();
  app.use(express.json());

  const container = createContainer(options);
  app.use('/', buildRouter(container));

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  return { app, container };
}

module.exports = { createApp };
