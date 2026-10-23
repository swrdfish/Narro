import { isKindleUrl, MAX_ARCHIVE_BYTES, MAX_BRIDGE_BYTES, readRenderArchive, normalizePages } from './kindle-data.js';

if (isKindleUrl(location.href) && !window.__aiReaderKindleIntercept) {
  window.__aiReaderKindleIntercept = true;
  install();
}

function install() {
  const originalFetch = window.fetch;
  const batches = [];
  let pending = 0;

  async function capture(response, url) {
    if (!response.ok || pending >= 3) return;
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_ARCHIVE_BYTES) return;
    pending++;
    let reader;
    try {
      reader = response.clone().body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > MAX_ARCHIVE_BYTES) throw new Error('Archive too large');
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const files = readRenderArchive(bytes.buffer);
      if (!files.has('glyphs.json')) return;
      const pages = [...files].filter(([name]) => name.startsWith('page_data_')).flatMap(([, value]) => normalizePages(value)).slice(0, 24);
      if (!pages.length) return;
      const book = url.searchParams.get('asin') || '';
      if (book.length > 40) return;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${book}:${JSON.stringify(files.get('glyphs.json'))}`));
      const id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      batches.push({ id, book, pages });
      while (batches.length > 6 || JSON.stringify(batches).length > MAX_BRIDGE_BYTES) batches.shift();
    } catch {
    } finally {
      reader?.cancel().catch(() => {});
      pending--;
    }
  }

  window.fetch = function (...args) {
    const result = Reflect.apply(originalFetch, this, args);
    try {
      const input = args[0];
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.origin === location.origin && url.pathname === '/renderer/render') {
        result.then((response) => capture(response, url)).catch(() => {});
      }
    } catch {}
    return result;
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'ai-reader-kindle-request') return;
    const requestId = event.data.requestId;
    if (typeof requestId !== 'string' || requestId.length > 80) return;
    const book = new URL(location.href).searchParams.get('asin');
    window.postMessage({ type: 'ai-reader-kindle-data', requestId, batches: batches.filter((batch) => book && batch.book === book) }, location.origin);
  });
}
