import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  analyzeLogistics, analyzeProduction, createBlueprintLibrary, decodeBlueprint,
  designBlueprint, encodeBlueprint, inspectBlueprint,
} from './lib/index.mjs';

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const exampleFiles = [
  { name: '组装工位', kind: 'design', path: '/examples/compact-assembly.json' },
  { name: 'R12 物流机器人配方链', kind: 'production', path: '/examples/r12-production.json' },
  { name: '不同车厢的站场与仓储', kind: 'logistics', path: '/examples/rail-logistics.json' },
  { name: 'R12 工厂整合蓝图', kind: 'blueprint', path: '/examples/r12/robot-district-integrated.txt' },
  { name: 'R12 工厂两件式蓝图书', kind: 'blueprint_book', path: '/examples/r12/robot-district-book.txt' },
];

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function method(request, ...allowed) {
  if (!allowed.includes(request.method)) {
    const error = new HttpError(405, 'method_not_allowed', `Allowed methods: ${allowed.join(', ')}`);
    error.allow = allowed.join(', ');
    throw error;
  }
}

async function loadJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    request.resume();
    throw new HttpError(415, 'unsupported_media_type', 'Use Content-Type: application/json');
  }
  if (Number(request.headers['content-length']) > MAX_JSON_BYTES) {
    request.resume();
    throw new HttpError(413, 'body_too_large', 'JSON input is limited to 4 MiB');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_JSON_BYTES) chunks.push(chunk);
      else reject(new HttpError(413, 'body_too_large', 'JSON input is limited to 4 MiB'));
    });
    request.on('error', reject);
    request.on('end', () => {
      if (size > MAX_JSON_BYTES) return;
      try {
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('expected object');
        resolve(body);
      } catch {
        reject(new HttpError(400, 'invalid_json', 'Body must be a UTF-8 JSON object'));
      }
    });
  });
}

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function invalidInput(error) {
  if (error instanceof HttpError) throw error;
  throw new HttpError(400, 'invalid_input', error.message);
}

const designOperations = new Map([
  ['/api/v1/designs', designBlueprint],
  ['/api/v1/production/analyze', analyzeProduction],
  ['/api/v1/logistics/analyze', analyzeLogistics],
  ['/api/v1/blueprints/encode', ({ document }) => ({ blueprint: encodeBlueprint(document) })],
  ['/api/v1/blueprints/decode', ({ blueprint }) => ({ document: decodeBlueprint(blueprint) })],
  ['/api/v1/blueprints/inspect', ({ blueprint }) => {
    const document = decodeBlueprint(blueprint);
    return { document, inspection: inspectBlueprint(document) };
  }],
]);

async function api(request, response, url, library) {
  const { pathname, searchParams } = url;
  const operation = designOperations.get(pathname);
  if (operation) {
    method(request, 'POST');
    const body = await loadJson(request);
    let result;
    try { result = operation(body); } catch (error) { invalidInput(error); }
    json(response, 200, result);
    return;
  }
  if (pathname === '/api/v1/health' || pathname === '/api/v1/examples') {
    method(request, 'GET');
    json(response, 200, pathname.endsWith('/health') ? { version: 'v1' } : { examples: exampleFiles });
    return;
  }
  if (pathname === '/api/v1/library') {
    method(request, 'GET', 'POST');
    if (request.method === 'GET') {
      const options = { q: searchParams.get('q') ?? '', key: searchParams.get('key') ?? undefined };
      const entries = await library.list(options).catch((error) => {
        if (error instanceof TypeError) invalidInput(error);
        throw error;
      });
      json(response, 200, { entries });
    } else {
      const body = await loadJson(request);
      const entry = await library.add(body).catch((error) => {
        if (error instanceof TypeError || error instanceof RangeError) invalidInput(error);
        throw error;
      });
      json(response, 200, { entry });
    }
    return;
  }
  const entryPath = /^\/api\/v1\/library\/([a-f0-9]{64})$/.exec(pathname);
  if (entryPath) {
    method(request, 'GET');
    const entry = await library.get(entryPath[1]);
    if (entry) {
      json(response, 200, { entry });
      return;
    }
  }
  throw new HttpError(404, 'not_found', 'API route or library revision not found');
}

const mime = new Map([
  ['.html', 'text/html'], ['.css', 'text/css'], ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'], ['.txt', 'text/plain'], ['.json', 'application/json'],
  ['.png', 'image/png'], ['.svg', 'image/svg+xml'],
]);

async function staticFile(request, response, url) {
  method(request, 'GET', 'HEAD');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'invalid_path', 'Invalid URL encoding'); }
  if (pathname === '/openapi.json') pathname = '/api/openapi.json';
  let base = new URL('./web/', import.meta.url);
  let relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  for (const directory of ['examples', 'api']) {
    if (relative.startsWith(`${directory}/`)) {
      base = new URL(`./${directory}/`, import.meta.url);
      relative = relative.slice(directory.length + 1);
      break;
    }
  }
  const root = resolve(fileURLToPath(base));
  const filename = resolve(root, relative);
  const contentType = mime.get(extname(filename));
  if (!filename.startsWith(root + sep) || !contentType || relative.includes('\\') || relative.includes('\0')) {
    throw new HttpError(404, 'not_found', 'File not found');
  }
  const data = await readFile(filename).catch((error) => {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) throw new HttpError(404, 'not_found', 'File not found');
    throw error;
  });
  response.writeHead(200, {
    'Content-Type': ['.png', '.svg'].includes(extname(filename)) ? contentType : `${contentType}; charset=utf-8`,
    'Content-Length': data.byteLength,
    'Cache-Control': 'no-cache',
  });
  response.end(request.method === 'HEAD' ? undefined : data);
}

export function createFactorioAgentServer({ library = createBlueprintLibrary() } = {}) {
  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const authority = request.headers.host ?? '';
      if (!/^(localhost|127\.0\.0\.1)(?::\d{1,5})?$/i.test(authority) || request.url?.[0] !== '/' || request.url.startsWith('//')) {
        throw new HttpError(403, 'local_only', 'Use a localhost URL');
      }
      let host;
      try { host = new URL(`http://${authority}`); } catch { throw new HttpError(403, 'local_only', 'Use a localhost URL'); }
      if (request.headers.origin && request.headers.origin !== host.origin) {
        throw new HttpError(403, 'local_only', 'Use the same local origin');
      }
      const url = new URL(request.url, host);
      if (url.origin !== host.origin) throw new HttpError(403, 'local_only', 'Use a localhost URL');
      if (url.pathname.startsWith('/api/v1/')) await api(request, response, url, library);
      else await staticFile(request, response, url);
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.allow) response.setHeader('Allow', error.allow);
        json(response, error.status, { error: { code: error.code, message: error.message } });
      } else {
        console.error(error);
        json(response, 500, { error: { code: 'internal_error', message: 'Local server error' } });
      }
    }
  });
}

function start() {
  const { values } = parseArgs({ options: { port: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('Usage: node server.mjs [--port 8787]');
    return;
  }
  const port = Number(values.port ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('Invalid port');
  const server = createFactorioAgentServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`Factorio Agent listening at http://127.0.0.1:${server.address().port}`);
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) start();
