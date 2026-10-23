// Previews the landing page: builds it, serves site-dist/ at http://localhost:8000 (or $PORT),
// and rebuilds when anything in site/ changes. Refresh the browser to see edits.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const root = 'site-dist';
const port = Number(process.env.PORT) || 8000;
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

const build = () => execFileSync(process.execPath, ['scripts/build-site.mjs'], { stdio: 'inherit' });
build();

let timer = null;
watch('site', { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      build();
    } catch {
      // build-site.mjs already printed the error; keep serving the last good build
    }
  }, 150);
});

createServer((req, res) => {
  // Stay inside site-dist/ whatever the URL says.
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://localhost').pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, path);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}).listen(port, () => console.log(`Previewing the landing page at http://localhost:${port} (rebuilds on changes; Ctrl+C to stop)`));
