const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const BUILTIN_DIR = path.join(PUBLIC_DIR, 'articles');
const BUILTIN_MANIFEST = path.join(BUILTIN_DIR, 'articles.json');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'articles');
const UPLOAD_MANIFEST = path.join(DATA_DIR, 'articles.json');
const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD || '';
const MAX_BODY = 10 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Uploaded pages get an opaque origin, so their scripts can't act as the library site.
const UPLOADED_CSP = 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads';

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Serialise manifest writes so two uploads can't overwrite each other's entries.
let writeQueue = Promise.resolve();
function updateUploads(fn) {
  const run = writeQueue.then(async () => {
    const entries = await readJson(UPLOAD_MANIFEST, []);
    const result = await fn(entries);
    await fsp.writeFile(UPLOAD_MANIFEST + '.tmp', JSON.stringify(entries, null, 2));
    await fsp.rename(UPLOAD_MANIFEST + '.tmp', UPLOAD_MANIFEST);
    return result;
  });
  writeQueue = run.catch(() => {});
  return run;
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? TYPES['.json'] : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function passwordOk(req) {
  const given = crypto.createHash('sha256').update(String(req.headers['x-upload-password'] || '')).digest();
  const expected = crypto.createHash('sha256').update(UPLOAD_PASSWORD).digest();
  return crypto.timingSafeEqual(given, expected);
}

function requireUploadAuth(req, res) {
  if (!UPLOAD_PASSWORD) {
    send(res, 503, { error: 'Uploads are turned off on this server.' });
    return false;
  }
  if (!passwordOk(req)) {
    send(res, 401, { error: 'Incorrect upload password.' });
    return false;
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('File is too large (10 MB limit).'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.html?$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function handleUpload(req, res) {
  if (!requireUploadAuth(req, res)) return;
  let data;
  try {
    data = JSON.parse(await readBody(req));
  } catch (err) {
    return send(res, err.status || 400, { error: err.status ? err.message : 'Invalid request.' });
  }

  const title = String(data.title || '').trim();
  const html = typeof data.html === 'string' ? data.html : '';
  const slug = slugify(data.filename || title);
  const today = new Date().toISOString().slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(data.date || '') ? data.date : today;

  if (!title) return send(res, 400, { error: 'A title is required.' });
  if (!html.trim()) return send(res, 400, { error: 'The HTML file is empty.' });
  if (!slug) return send(res, 400, { error: 'Could not make a file name from that title.' });

  const file = slug + '.html';
  if (fs.existsSync(path.join(BUILTIN_DIR, file))) {
    return send(res, 409, { error: `"${file}" is a built-in article. Use a different file name.` });
  }

  const entry = {
    title,
    summary: String(data.summary || '').trim(),
    category: String(data.category || '').trim(),
    date,
    file,
  };

  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  const replaced = await updateUploads(async entries => {
    await fsp.writeFile(path.join(UPLOAD_DIR, file), html);
    const i = entries.findIndex(e => e.file === file);
    if (i >= 0) entries[i] = entry;
    else entries.push(entry);
    return i >= 0;
  });
  send(res, replaced ? 200 : 201, { entry, replaced });
}

async function handleDelete(req, res, file) {
  if (!requireUploadAuth(req, res)) return;
  const removed = await updateUploads(async entries => {
    const i = entries.findIndex(e => e.file === file);
    if (i < 0) return false;
    entries.splice(i, 1);
    await fsp.rm(path.join(UPLOAD_DIR, file), { force: true });
    return true;
  });
  if (!removed) return send(res, 404, { error: 'No uploaded article with that file name.' });
  send(res, 200, { deleted: file });
}

async function serveFile(res, file, headers = {}) {
  try {
    const body = await fsp.readFile(file);
    send(res, 200, body, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...headers,
    });
  } catch {
    send(res, 404, 'Not found');
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }

  if (pathname === '/api/status' && req.method === 'GET') {
    return send(res, 200, { uploadsEnabled: Boolean(UPLOAD_PASSWORD) });
  }
  if (pathname === '/api/articles' && req.method === 'POST') {
    return handleUpload(req, res);
  }
  const del = pathname.match(/^\/api\/articles\/([a-z0-9-]+\.html)$/);
  if (del && req.method === 'DELETE') {
    return handleDelete(req, res, del[1]);
  }
  if (pathname.startsWith('/api/')) {
    return send(res, 404, { error: 'Not found' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed');
  }

  // The library lists built-in articles from the repo plus anything uploaded.
  if (pathname === '/articles/articles.json') {
    const builtin = await readJson(BUILTIN_MANIFEST, []);
    const uploaded = (await readJson(UPLOAD_MANIFEST, [])).map(e => ({ ...e, uploaded: true }));
    return send(res, 200, [...builtin, ...uploaded], { 'Cache-Control': 'no-cache' });
  }

  const upload = pathname.match(/^\/articles\/([a-z0-9-]+\.html)$/);
  if (upload && fs.existsSync(path.join(UPLOAD_DIR, upload[1]))) {
    return serveFile(res, path.join(UPLOAD_DIR, upload[1]), { 'Content-Security-Policy': UPLOADED_CSP });
  }

  const target = path.resolve(PUBLIC_DIR, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
  if (!target.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 404, 'Not found');
  }
  return serveFile(res, target);
}

http
  .createServer((req, res) => {
    handle(req, res).catch(err => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'Something went wrong on the server.' });
    });
  })
  .listen(PORT, () => {
    console.log(`IT Library listening on :${PORT} (uploads ${UPLOAD_PASSWORD ? 'enabled' : 'disabled'}, data in ${DATA_DIR})`);
  });
