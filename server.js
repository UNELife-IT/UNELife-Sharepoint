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
// Admin edits to built-in articles (which live read-only in the repo): { file: { title, summary, category, date, hidden } }
const OVERRIDES = path.join(DATA_DIR, 'overrides.json');
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

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file + '.tmp', JSON.stringify(data, null, 2));
  await fsp.rename(file + '.tmp', file);
}

// Serialise all data writes so two admins can't overwrite each other's changes.
let writeQueue = Promise.resolve();
function updateData(fn) {
  const run = writeQueue.then(async () => {
    const store = {
      uploads: await readJson(UPLOAD_MANIFEST, []),
      overrides: await readJson(OVERRIDES, {}),
    };
    const result = await fn(store);
    await writeJson(UPLOAD_MANIFEST, store.uploads);
    await writeJson(OVERRIDES, store.overrides);
    return result;
  });
  writeQueue = run.catch(() => {});
  return run;
}

// Every article with its source, admin edits applied, hidden ones included.
async function allArticles() {
  const builtin = await readJson(BUILTIN_MANIFEST, []);
  const overrides = await readJson(OVERRIDES, {});
  const uploads = await readJson(UPLOAD_MANIFEST, []);
  return [
    ...builtin.map(e => ({ ...e, ...overrides[e.file], source: 'builtin' })),
    ...uploads.map(e => ({ ...e, source: 'uploaded' })),
  ].map(e => ({ ...e, hidden: Boolean(e.hidden) }));
}

async function isBuiltin(file) {
  return (await readJson(BUILTIN_MANIFEST, [])).some(e => e.file === file);
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

async function readJsonBody(req, res) {
  try {
    return JSON.parse(await readBody(req));
  } catch (err) {
    send(res, err.status || 400, { error: err.status ? err.message : 'Invalid request.' });
    return null;
  }
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.html?$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// Validates the editable fields shared by upload and edit. Returns an error message or the cleaned fields.
function cleanFields(data) {
  const title = String(data.title || '').trim();
  if (!title) return { error: 'A title is required.' };
  const today = new Date().toISOString().slice(0, 10);
  return {
    fields: {
      title,
      summary: String(data.summary || '').trim(),
      category: String(data.category || '').trim(),
      date: /^\d{4}-\d{2}-\d{2}$/.test(data.date || '') ? data.date : today,
    },
  };
}

async function handleUpload(req, res) {
  if (!requireUploadAuth(req, res)) return;
  const data = await readJsonBody(req, res);
  if (!data) return;

  const { fields, error } = cleanFields(data);
  if (error) return send(res, 400, { error });
  const html = typeof data.html === 'string' ? data.html : '';
  if (!html.trim()) return send(res, 400, { error: 'The HTML file is empty.' });
  const slug = slugify(data.filename || fields.title);
  if (!slug) return send(res, 400, { error: 'Could not make a file name from that title.' });

  const file = slug + '.html';
  if (await isBuiltin(file) || fs.existsSync(path.join(BUILTIN_DIR, file))) {
    return send(res, 409, { error: `"${file}" is a built-in article. Use a different file name.` });
  }

  const entry = { ...fields, file };
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  const replaced = await updateData(async ({ uploads }) => {
    await fsp.writeFile(path.join(UPLOAD_DIR, file), html);
    const i = uploads.findIndex(e => e.file === file);
    if (i >= 0) uploads[i] = entry;
    else uploads.push(entry);
    return i >= 0;
  });
  send(res, replaced ? 200 : 201, { entry, replaced });
}

// Edit an article's details. Uploaded articles can also have their HTML replaced.
async function handleEdit(req, res, file) {
  if (!requireUploadAuth(req, res)) return;
  const data = await readJsonBody(req, res);
  if (!data) return;
  const { fields, error } = cleanFields(data);
  if (error) return send(res, 400, { error });
  const html = typeof data.html === 'string' && data.html.trim() ? data.html : null;
  const builtin = await isBuiltin(file);
  if (builtin && html) {
    return send(res, 400, { error: 'Built-in articles live in the repo, so their file can only be changed there.' });
  }

  const found = await updateData(async ({ uploads, overrides }) => {
    if (builtin) {
      overrides[file] = { ...overrides[file], ...fields };
      return true;
    }
    const i = uploads.findIndex(e => e.file === file);
    if (i < 0) return false;
    if (html) await fsp.writeFile(path.join(UPLOAD_DIR, file), html);
    uploads[i] = { ...uploads[i], ...fields };
    return true;
  });
  if (!found) return send(res, 404, { error: 'No article with that file name.' });
  send(res, 200, { updated: file });
}

// Uploaded articles are deleted; built-in ones are hidden so they can be restored.
async function handleDelete(req, res, file) {
  if (!requireUploadAuth(req, res)) return;
  const builtin = await isBuiltin(file);
  const result = await updateData(async ({ uploads, overrides }) => {
    if (builtin) {
      overrides[file] = { ...overrides[file], hidden: true };
      return 'hidden';
    }
    const i = uploads.findIndex(e => e.file === file);
    if (i < 0) return null;
    uploads.splice(i, 1);
    await fsp.rm(path.join(UPLOAD_DIR, file), { force: true });
    return 'deleted';
  });
  if (!result) return send(res, 404, { error: 'No article with that file name.' });
  send(res, 200, { [result]: file });
}

async function handleRestore(req, res, file) {
  if (!requireUploadAuth(req, res)) return;
  if (!(await isBuiltin(file))) return send(res, 404, { error: 'Only built-in articles can be restored.' });
  await updateData(async ({ overrides }) => {
    if (overrides[file]) delete overrides[file].hidden;
  });
  send(res, 200, { restored: file });
}

// Rename (or merge, or clear) a category across every article that uses it.
async function handleRenameCategory(req, res) {
  if (!requireUploadAuth(req, res)) return;
  const data = await readJsonBody(req, res);
  if (!data) return;
  const from = String(data.from || '').trim();
  const to = String(data.to || '').trim();
  if (!from) return send(res, 400, { error: 'Choose a category to rename.' });

  const builtin = await readJson(BUILTIN_MANIFEST, []);
  const changed = await updateData(async ({ uploads, overrides }) => {
    let count = 0;
    for (const e of uploads) {
      if (e.category === from) { e.category = to; count++; }
    }
    for (const e of builtin) {
      const current = overrides[e.file]?.category ?? e.category;
      if (current === from) { overrides[e.file] = { ...overrides[e.file], category: to }; count++; }
    }
    return count;
  });
  send(res, 200, { changed });
}

// Added to every article page so readers can always get back to the library,
// including uploaded guides that have no navigation of their own.
const BACK_BUTTON = `
<a href="/" id="library-back-btn" aria-label="Back to the IT Library" style="position:fixed;left:24px;bottom:24px;z-index:2147483647;display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border-radius:24px;background:#1b7a3d;color:#fff;font:600 15px/1.2 'Segoe UI',system-ui,-apple-system,Roboto,Arial,sans-serif;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.3);">&larr; Back to library</a>
<style media="print">#library-back-btn{display:none!important}</style>
`;

function addBackButton(html) {
  const i = html.toLowerCase().lastIndexOf('</body>');
  return i < 0 ? html + BACK_BUTTON : html.slice(0, i) + BACK_BUTTON + html.slice(i);
}

async function serveFile(res, file, headers = {}) {
  try {
    let body = await fsp.readFile(file);
    if (path.extname(file).toLowerCase() === '.html' && path.dirname(file) !== PUBLIC_DIR) {
      body = addBackButton(body.toString('utf8'));
    }
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
  const method = req.method;

  if (pathname === '/api/status' && method === 'GET') {
    return send(res, 200, { uploadsEnabled: Boolean(UPLOAD_PASSWORD) });
  }
  if (pathname === '/api/admin/check' && method === 'POST') {
    if (!requireUploadAuth(req, res)) return;
    return send(res, 200, { ok: true });
  }
  if (pathname === '/api/admin/articles' && method === 'GET') {
    if (!requireUploadAuth(req, res)) return;
    return send(res, 200, await allArticles());
  }
  if (pathname === '/api/categories/rename' && method === 'POST') {
    return handleRenameCategory(req, res);
  }
  if (pathname === '/api/articles' && method === 'POST') {
    return handleUpload(req, res);
  }
  const art = pathname.match(/^\/api\/articles\/([a-z0-9-]+\.html)(\/restore)?$/);
  if (art && art[2] && method === 'POST') return handleRestore(req, res, art[1]);
  if (art && !art[2] && method === 'PUT') return handleEdit(req, res, art[1]);
  if (art && !art[2] && method === 'DELETE') return handleDelete(req, res, art[1]);
  if (pathname.startsWith('/api/')) {
    return send(res, 404, { error: 'Not found' });
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return send(res, 405, 'Method not allowed');
  }

  // The public library list: built-in and uploaded articles, minus hidden ones.
  if (pathname === '/articles/articles.json') {
    const visible = (await allArticles())
      .filter(e => !e.hidden)
      .map(({ source, hidden, ...e }) => (source === 'uploaded' ? { ...e, uploaded: true } : e));
    return send(res, 200, visible, { 'Cache-Control': 'no-cache' });
  }

  const article = pathname.match(/^\/articles\/([a-z0-9-]+\.html)$/);
  if (article) {
    const overrides = await readJson(OVERRIDES, {});
    if (overrides[article[1]]?.hidden) return send(res, 404, 'Not found');
    if (fs.existsSync(path.join(UPLOAD_DIR, article[1]))) {
      return serveFile(res, path.join(UPLOAD_DIR, article[1]), { 'Content-Security-Policy': UPLOADED_CSP });
    }
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
