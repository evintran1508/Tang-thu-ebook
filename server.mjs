import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(ROOT, 'data', 'userdata.json');
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8'
};

const EMPTY_DATA = { saved: [], progress: {}, prefs: {}, updatedAt: 0 };

function readUserData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return EMPTY_DATA;
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      saved: Array.isArray(parsed.saved) ? parsed.saved : [],
      progress: parsed.progress && typeof parsed.progress === 'object' ? parsed.progress : {},
      prefs: parsed.prefs && typeof parsed.prefs === 'object' ? parsed.prefs : {},
      updatedAt: Number(parsed.updatedAt || 0)
    };
  } catch {
    return EMPTY_DATA;
  }
}

function mergeUserData(cur, incoming) {
  let saved = cur.saved;
  if (Array.isArray(incoming.saved)) {
    // If client is intentionally syncing, allow update, but protect against unhydrated wipe
    if (incoming.saved.length > 0 || incoming.clearSaved || incoming.replaceSaved || cur.saved.length === 0) {
      saved = incoming.saved;
    }
  }
  let progress = { ...cur.progress, ...(incoming.progress || {}) };
  if (Array.isArray(incoming.removedProgress)) {
    for (const id of incoming.removedProgress) {
      if (typeof id === 'string') delete progress[id];
    }
  }
  if (incoming.clearProgress === true) {
    progress = {};
  }
  if (incoming.replaceProgress === true && incoming.progress && typeof incoming.progress === 'object') {
    progress = incoming.progress;
  }
  const prefs = { ...cur.prefs, ...(incoming.prefs || {}) };
  return {
    saved,
    progress,
    prefs
  };
}

function writeUserData(next) {
  const safe = {
    saved: Array.isArray(next.saved) ? next.saved : [],
    progress: next.progress && typeof next.progress === 'object' ? next.progress : {},
    prefs: next.prefs && typeof next.prefs === 'object' ? next.prefs : {},
    updatedAt: Date.now()
  };
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(safe, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
  return safe;
}

process.on('uncaughtException', (err) => {
  console.error('[server error]', err);
});

const server = http.createServer((req, res) => {
  let cleanUrl;
  try {
    cleanUrl = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  if (cleanUrl === '/api/userdata') {
    if (req.method === 'GET') {
      const data = readUserData();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
      return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        if (body.length < 2_000_000) body += chunk;
      });
      req.on('end', () => {
        try {
          const incoming = JSON.parse(body || '{}');
          const cur = readUserData();
          const merged = mergeUserData(cur, incoming);
          const saved = writeUserData(merged);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, updatedAt: saved.updatedAt }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false }));
        }
      });
      return;
    }
  }

  const relPath = cleanUrl === '/' ? '/index.html' : cleanUrl;
  const filePath = path.resolve(ROOT, `.${relPath}`);
  const relFromRoot = path.relative(ROOT, filePath);

  if (
    relFromRoot.startsWith('..') ||
    path.isAbsolute(relFromRoot) ||
    cleanUrl.startsWith('/data/userdata') ||
    cleanUrl.endsWith('server.mjs') ||
    cleanUrl.endsWith('test.mjs') ||
    /(^|\/)\.[^.]/.test(cleanUrl)
  ) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`Serving Tàng Thư on http://localhost:${PORT}`);
});
