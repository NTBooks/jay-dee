// Usage: npm run serve   (station at http://localhost:3131)
import { createApp } from '../src/server/app.mjs';
import { config } from '../src/config.mjs';
import { log } from '../src/util/log.mjs';

const { app } = createApp();
const server = app.listen(config.port, () => {
  log.info(`Jay Dee station listening on http://localhost:${config.port}`);
  if (!config.openrouter.apiKey) log.warn('OPENROUTER_API_KEY not set: playback/search work, but the DJ cannot plan sets until it is added to .env');
});
const shutdown = () => { log.info('shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
