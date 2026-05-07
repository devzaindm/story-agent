/**
 * Story Agent — local file server
 * Run in Comtrak project directory: node C:\Zain\story-agent\story-agent-server.js
 * Or run from Comtrak root:         node ../story-agent/story-agent-server.js
 * Serves on http://localhost:3001
 *
 * Endpoints:
 *   GET  /files              → list all .component.ts paths under /src of Comtrak
 *   GET  /file?path=...      → read a file (path relative to Comtrak root)
 *   POST /file {path,content}→ write a file into Comtrak project
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const PORT = 3001;

// Points to the Comtrak FE project — adjust if your path differs
const PROJECT_ROOT = path.resolve('C:\\Zain\\Comtrak_FE');

function walkComponents(dir, result = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return result; }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkComponents(full, result);
    } else if (entry.isFile() && entry.name.endsWith('.component.ts')) {
      result.push('/' + path.relative(PROJECT_ROOT, full).replace(/\\/g, '/'));
    }
  }
  return result;
}

function safePath(rawPath) {
  const abs = path.resolve(PROJECT_ROOT, rawPath.replace(/^\//, ''));
  if (!abs.startsWith(PROJECT_ROOT + path.sep) && abs !== PROJECT_ROOT) return null;
  return abs;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = http.createServer((req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'GET' && pathname === '/files') {
    const files = walkComponents(path.join(PROJECT_ROOT, 'src'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ files }));
  }

  if (req.method === 'GET' && pathname === '/file') {
    const abs = safePath(String(parsed.query.path ?? ''));
    if (!abs || !fs.existsSync(abs)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Not found' }));
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(fs.readFileSync(abs, 'utf8'));
  }

  if (req.method === 'POST' && pathname === '/file') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { path: filePath, content } = JSON.parse(body);
        const abs = safePath(filePath);
        if (!abs) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Path outside project root' }));
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: filePath }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  Story Agent file server`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Comtrak root: ${PROJECT_ROOT}\n`);
});
