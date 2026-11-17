import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { explainDiff, type ExplainPayload } from './server/explainCore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, aiConfigured: Boolean(process.env.GEMINI_API_KEY) });
  });

  app.use('/api/explain', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.post('/api/explain', async (req, res) => {
    try {
      const payload = req.body as ExplainPayload;
      if (!payload || typeof payload.hunksPatch !== 'string') {
        res.status(400).json({ error: 'Invalid diff payload: hunksPatch string is required.' });
        return;
      }

      const result = await explainDiff(payload);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unexpected server error';
      const status = message.includes('MISSING_API_KEY')
        ? 503
        : message.includes('RESOURCE_EXHAUSTED') || message.includes('429')
        ? 429
        : 500;
      res.status(status).json({ error: message });
    }
  });

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DiffLens server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
