// Notes server: serves the web app and the files in NOTES_DIR.
// Files are plain files on disk (drop them in with scp and they show up).
// Stars, tags, type and importance live in NOTES_DIR/.shelf.json, keyed by relative path.
// No auth here: Caddy only lets tailnet devices through.

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8798);
const HOST = process.env.HOST || '127.0.0.1';
const NOTES_DIR = resolve(process.env.NOTES_DIR || join(process.env.HOME || '.', 'notes'));
const STATIC_DIR = resolve(process.env.STATIC_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
const META_FILE = join(NOTES_DIR, '.shelf.json');
const TRASH_DIR = join(NOTES_DIR, '.trash');
const MAX_UPLOAD = 200 * 1024 * 1024;

const KINDS = {
  '.pdf': 'pdf',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  '.txt': 'text',
};
const MIME = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

// ---------- metadata ----------

let meta = {};
let writeChain = Promise.resolve();

async function loadMeta() {
  try {
    meta = JSON.parse(await readFile(META_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    meta = {};
  }
}

function saveMeta() {
  writeChain = writeChain.then(async () => {
    const tmp = `${META_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(meta, null, 2));
    await rename(tmp, META_FILE);
  });
  return writeChain;
}

// ---------- paths ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Resolve a user-supplied relative path inside NOTES_DIR; refuse anything hidden or outside.
function safePath(rel) {
  if (typeof rel !== 'string' || !rel) throw new HttpError(400, 'Missing path');
  const abs = resolve(NOTES_DIR, rel);
  const r = relative(NOTES_DIR, abs);
  if (!r || r.startsWith('..') || resolve(NOTES_DIR, r) !== abs) throw new HttpError(400, 'Bad path');
  if (r.split(sep).some((part) => part.startsWith('.'))) throw new HttpError(400, 'Bad path');
  return { abs, rel: r.split(sep).join('/') };
}

function cleanName(name) {
  const n = basename(String(name || '')).replace(/[\0/\\]/g, '').trim();
  if (!n || n.startsWith('.')) throw new HttpError(400, 'Bad file name');
  return n;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function freeName(dir, name) {
  const ext = extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 2; await exists(join(dir, candidate)); i++) candidate = `${base} (${i})${ext}`;
  return candidate;
}

// ---------- listing ----------

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return out;
    throw e;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) await walk(abs, out);
    else if (e.isFile() && KINDS[extname(e.name).toLowerCase()]) out.push(abs);
  }
  return out;
}

async function listNotes() {
  const files = await walk(NOTES_DIR);
  const notes = await Promise.all(
    files.map(async (abs) => {
      const s = await stat(abs);
      const rel = relative(NOTES_DIR, abs).split(sep).join('/');
      const m = meta[rel] || {};
      const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      return {
        path: rel,
        name: basename(rel),
        folder,
        kind: KINDS[extname(abs).toLowerCase()],
        size: s.size,
        modifiedTime: s.mtime.toISOString(),
        createdTime: (s.birthtimeMs ? s.birthtime : s.mtime).toISOString(),
        starred: !!m.starred,
        tags: Array.isArray(m.tags) ? m.tags : [],
        type: typeof m.type === 'string' ? m.type : '',
        importance: Number.isInteger(m.importance) ? m.importance : 0,
      };
    }),
  );
  // Drop metadata for files that were deleted outside the app.
  const live = new Set(notes.map((n) => n.path));
  if (Object.keys(meta).some((k) => !live.has(k))) {
    for (const k of Object.keys(meta)) if (!live.has(k)) delete meta[k];
    await saveMeta();
  }
  return notes;
}

// ---------- changes ----------

function cleanMeta(body, current) {
  const next = { ...current };
  if ('starred' in body) next.starred = !!body.starred;
  if ('tags' in body) {
    if (!Array.isArray(body.tags)) throw new HttpError(400, 'tags must be a list');
    const seen = new Set();
    next.tags = body.tags
      .map((t) => String(t).trim().slice(0, 60))
      .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
      .slice(0, 40);
  }
  if ('type' in body) next.type = String(body.type || '').trim().slice(0, 60);
  if ('importance' in body) {
    const n = Number(body.importance);
    if (!Number.isInteger(n) || n < 0 || n > 5) throw new HttpError(400, 'importance must be 0-5');
    next.importance = n;
  }
  for (const k of Object.keys(next)) if (!next[k] || (Array.isArray(next[k]) && !next[k].length)) delete next[k];
  return next;
}

async function patchNote(rel, body) {
  const { abs, rel: key } = safePath(rel);
  if (!(await exists(abs))) throw new HttpError(404, 'File not found');
  let finalKey = key;
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (extname(name).toLowerCase() !== extname(key).toLowerCase()) throw new HttpError(400, 'Keep the same file extension');
    if (name !== basename(key)) {
      const target = join(dirname(abs), name);
      if (await exists(target)) throw new HttpError(409, 'A file with that name already exists');
      await rename(abs, target);
      finalKey = relative(NOTES_DIR, target).split(sep).join('/');
      if (meta[key]) {
        meta[finalKey] = meta[key];
        delete meta[key];
      }
    }
  }
  const next = cleanMeta(body, meta[finalKey] || {});
  if (Object.keys(next).length) meta[finalKey] = next;
  else delete meta[finalKey];
  await saveMeta();
  return { path: finalKey };
}

async function trashNote(rel) {
  const { abs, rel: key } = safePath(rel);
  if (!(await exists(abs))) throw new HttpError(404, 'File not found');
  await mkdir(TRASH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await rename(abs, join(TRASH_DIR, `${stamp} ${basename(abs)}`));
  delete meta[key];
  await saveMeta();
}

async function upload(req, folderRel, rawName) {
  const name = cleanName(rawName);
  if (!KINDS[extname(name).toLowerCase()]) throw new HttpError(400, 'Only PDF, Markdown, HTML and text files');
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD) throw new HttpError(413, 'File is too big (200 MB max)');
  const dir = folderRel ? safePath(folderRel).abs : NOTES_DIR;
  await mkdir(dir, { recursive: true });
  const finalName = await freeName(dir, name);
  const target = join(dir, finalName);
  const tmp = join(NOTES_DIR, `.upload-${process.pid}-${Date.now()}`);
  let received = 0;
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_UPLOAD) req.destroy(new HttpError(413, 'File is too big (200 MB max)'));
  });
  try {
    await pipeline(req, createWriteStream(tmp));
    await rename(tmp, target);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  return { path: relative(NOTES_DIR, target).split(sep).join('/') };
}

// ---------- http ----------

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new HttpError(413, 'Body too big');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Bad JSON');
  }
}

async function serveFile(res, abs, headers = {}) {
  const s = await stat(abs).catch(() => null);
  if (!s?.isFile()) return false;
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream',
    'Content-Length': s.size,
    ...headers,
  });
  await pipeline(createReadStream(abs), res);
  return true;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;

  // A request with an Origin header from somewhere else is never ours.
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && new URL(origin).host !== req.headers.host) {
    throw new HttpError(403, 'Cross-site request blocked');
  }

  if (p === '/api/notes' && req.method === 'GET') return send(res, 200, { notes: await listNotes() });
  if (p === '/api/notes' && req.method === 'PATCH') {
    return send(res, 200, await patchNote(url.searchParams.get('path'), await readJson(req)));
  }
  if (p === '/api/notes' && req.method === 'DELETE') {
    await trashNote(url.searchParams.get('path'));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/upload' && req.method === 'POST') {
    return send(res, 200, await upload(req, url.searchParams.get('folder') || '', url.searchParams.get('name')));
  }

  if (p.startsWith('/raw/') && req.method === 'GET') {
    const { abs } = safePath(decodeURIComponent(p.slice(5)));
    const ext = extname(abs).toLowerCase();
    const headers = { 'Cache-Control': 'private, no-cache' };
    // HTML notes run in an opaque origin so their scripts can't reach the app's API.
    if (ext === '.html' || ext === '.htm') headers['Content-Security-Policy'] = 'sandbox allow-scripts allow-popups allow-forms';
    if (url.searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(abs))}`;
    if (await serveFile(res, abs, headers)) return;
    throw new HttpError(404, 'File not found');
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');

  // Static app with SPA fallback.
  const staticPath = resolve(STATIC_DIR, '.' + decodeURIComponent(p));
  if (staticPath.startsWith(STATIC_DIR + sep)) {
    const cache = p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    if (await serveFile(res, staticPath, { 'Cache-Control': cache })) return;
  }
  if (!(await serveFile(res, join(STATIC_DIR, 'index.html'), { 'Cache-Control': 'no-cache' }))) {
    send(res, 404, 'App not built');
  }
}

await mkdir(NOTES_DIR, { recursive: true });
await loadMeta();

createServer((req, res) => {
  handle(req, res).catch((e) => {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Server error' : e.message });
    else res.destroy();
  });
}).listen(PORT, HOST, () => console.log(`notes on http://${HOST}:${PORT} serving ${NOTES_DIR}`));
