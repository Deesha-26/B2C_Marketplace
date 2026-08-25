/**
 * Minimal Express stand-in for offline testing ONLY.
 *
 * Implements just the surface server/index.js uses: routing with :params,
 * json/raw body parsers, res.json/status, req.get/params/body, and listen()
 * over node:http. Production uses the real express from package.json.
 */
import http from 'node:http';
import fs from 'node:fs';
import nodePath from 'node:path';

function makeRes(raw) {
  const res = {
    _raw: raw,
    _sentHead: false,
    statusCode: 200,
    status(code) { res.statusCode = code; return res; },
    json(obj) {
      const body = JSON.stringify(obj ?? null);
      raw.writeHead(res.statusCode, { 'Content-Type': 'application/json' });
      raw.end(body);
      return res;
    },
    type(mime) { res._mime = mime; return res; },
    send(text) {
      if (!raw.headersSent) raw.writeHead(res.statusCode, res._mime ? { 'Content-Type': res._mime } : undefined);
      raw.end(String(text ?? '')); return res;
    },
  };
  return res;
}

function matchPath(pattern, url) {
  const p = pattern.split('/').filter(Boolean);
  const u = url.split('?')[0].split('/').filter(Boolean);
  if (p.length !== u.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(u[i]);
    else if (p[i] !== u[i]) return null;
  }
  return params;
}

export default function express() {
  const routes = [];
  const middleware = [];

  const app = (req, res) => handle(req, res);
  app.use = (...args) => {
    const fn = args[args.length - 1];
    if (typeof fn === 'function') middleware.push(fn);
    return app;
  };
  for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
    app[method] = (path, ...handlers) => {
      routes.push({ method: method.toUpperCase(), path, handlers });
      return app;
    };
  }

  async function handle(rawReq, rawRes) {
    const chunks = [];
    for await (const c of rawReq) chunks.push(c);
    const buf = Buffer.concat(chunks);

    const req = {
      method: rawReq.method, url: rawReq.url, headers: rawReq.headers,
      params: {}, body: undefined, rawBody: buf,
      get: name => rawReq.headers[String(name).toLowerCase()],
    };
    const res = makeRes(rawRes);
    const route = routes.find(r => r.method === req.method && matchPath(r.path, req.url));
    if (route) req.params = matchPath(route.path, req.url);

    // Middleware runs for EVERY request, matched or not — that is how
    // express.static serves files on paths with no route.
    const chain = [...middleware, ...(route ? route.handlers : [])];
    let i = 0;
    const next = async err => {
      if (err) { if (!rawRes.headersSent) res.status(500).json({ error: String(err.message || err) }); return; }
      if (rawRes.headersSent) return;
      const fn = chain[i++];
      if (!fn) {
        if (!route && !rawRes.headersSent) res.status(404).json({ error: 'not found' });
        return;
      }
      if (fn.length >= 3) return fn(req, res, next);   // middleware
      return fn(req, res);                              // handler
    };
    try { await next(); }
    catch (err) { if (!rawRes.headersSent) res.status(500).json({ error: String(err.message) }); }
  }

  app.listen = (port, cb) => {
    const server = http.createServer(handle);
    server.listen(port, cb);
    return server;
  };
  return app;
}

express.json = () => (req, res, next) => {
  if (req.body === undefined && req.rawBody?.length) {
    try { req.body = JSON.parse(req.rawBody.toString('utf8')); } catch { req.body = {}; }
  }
  req.body ??= {};
  return next();
};
express.raw = () => (req, res, next) => { req.body = req.rawBody; return next(); };
const MIME = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript',
  '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };

express.static = root => (req, res, next) => {
  if (req.method !== 'GET') return next();
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const file = nodePath.join(root, nodePath.normalize(rel));
  if (!file.startsWith(nodePath.resolve(root))) return next();   // no traversal
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
  res.status(200).type(MIME[nodePath.extname(file)] || 'application/octet-stream');
  res.send(fs.readFileSync(file, 'utf8'));
};
