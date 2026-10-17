import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root, images, dataDir, storage, PAGES } from './server/store.mjs';
import { handleApi, seoFor } from './server/api.mjs';

const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '127.0.0.1';
const pages = new Set(PAGES);
const shared = new Set(['styles.css', 'pages.css', 'fonts.css', 'script.js', 'site.js']);
const admin = new Set(['admin/index.html', 'admin/admin.css', 'admin/admin.js', 'admin/vendor/qrcode.js']);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const attribute = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Page titles and descriptions set in the admin panel replace the built-in ones as the page is served.
function applySeo(html, page) {
  const seo = seoFor(page);
  if (!seo) return html;
  if (seo.title) html = html.replace(/<title>[^<]*<\/title>/, `<title>${attribute(seo.title)}</title>`).replace(/(<meta property="og:title" content=")[^"]*/, `$1${attribute(seo.title)}`);
  if (seo.description) html = html.replace(/(<meta name="description" content=")[^"]*/, `$1${attribute(seo.description)}`).replace(/(<meta property="og:description" content=")[^"]*/, `$1${attribute(seo.description)}`);
  return html;
}

const server = http.createServer(async (request, response) => {
  let url;
  try { url = new URL(request.url, 'http://localhost'); decodeURIComponent(url.pathname); }
  catch { response.writeHead(400); response.end('Bad request'); return; }
  // Only trust a proxy's forwarded address when the deployment says there is one.
  const ip = (process.env.TRUST_PROXY && String(request.headers['x-forwarded-for'] || '').split(',')[0].trim()) || request.socket.remoteAddress || '';
  if (url.pathname.startsWith('/api/')) { await handleApi(request, response, url, ip); return; }
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method not allowed');
    return;
  }
  let resource = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  if (resource === 'admin') { response.writeHead(302, { Location: '/admin/' }); response.end(); return; }
  if (resource === 'admin/') resource = 'admin/index.html';
  const upload = /^uploads\/([a-f0-9]+\.(?:jpg|png|webp))$/.exec(resource);
  const permitted = pages.has(resource) || shared.has(resource) || admin.has(resource) || /^assets\/[a-zA-Z0-9_-]+\.(jpg|svg|woff2|txt)$/.test(resource);
  let body;
  let status = 200;
  try {
    if (upload) {
      // Photos not yet approved (guest memories awaiting review) are never served.
      const photo = await images.get(upload[1]);
      if (!photo?.public) throw new Error('Not public');
      body = photo.bytes;
    } else if (!permitted) throw new Error('Not public');
    else body = await readFile(path.join(root, resource));
    if (pages.has(resource)) body = applySeo(body.toString('utf8'), resource);
  } catch {
    resource = '404.html';
    status = 404;
    body = (await readFile(path.join(root, resource), 'utf8')).replace('<head>', '<head><base href="/">');
  }
  const headers = {
    'Content-Type': types[path.extname(resource)] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': upload ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (admin.has(resource)) Object.assign(headers, { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'Cache-Control': 'no-store' });
  response.writeHead(status, headers);
  response.end(request.method === 'HEAD' ? undefined : body);
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, host, () => console.log(`Nasha website: http://localhost:${port}\nAdmin panel:   http://localhost:${port}/admin/\nData saved in: ${storage}\nLocal copy:    ${dataDir}`));
