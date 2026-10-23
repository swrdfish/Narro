export const KINDLE_HOSTS = ['read.amazon.in', 'read.amazon.com', 'read.amazon.co.uk', 'read.amazon.ca', 'read.amazon.com.au', 'read.amazon.co.jp', 'read.amazon.de', 'read.amazon.fr', 'read.amazon.it', 'read.amazon.es', 'read.amazon.com.br', 'read.amazon.com.mx'];
export const MAX_ARCHIVE_BYTES = 24 * 1024 * 1024;
export const MAX_BRIDGE_BYTES = 4 * 1024 * 1024;

export function isKindleUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && KINDLE_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

export function readRenderArchive(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('Kindle render archive is too large.');
  const decoder = new TextDecoder();
  const files = new Map();
  let total = 0;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      offset += 512;
      continue;
    }
    const field = (start, end) => decoder.decode(header.subarray(start, end)).replace(/\0.*$/s, '').trim();
    const sizeText = field(124, 136);
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('Invalid Kindle archive size.');
    const size = parseInt(sizeText, 8);
    const checksum = parseInt(field(148, 156), 8);
    const sum = header.reduce((value, byte, index) => value + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (sum !== checksum || offset + 512 + size > bytes.length) throw new Error('Invalid Kindle archive header.');
    const name = field(0, 100).split('/').pop();
    if ((header[156] === 0 || header[156] === 48) && /^(page_data_\d+_\d+|glyphs)\.json$/.test(name)) {
      total += size;
      if (total > MAX_BRIDGE_BYTES || files.size >= 40) throw new Error('Kindle metadata exceeds limits.');
      files.set(name, JSON.parse(decoder.decode(bytes.subarray(offset + 512, offset + 512 + size))));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function translation(value) {
  if (value == null) return [0, 0];
  if (Array.isArray(value) && value.length === 6 && value.every(Number.isFinite)) {
    if (value[0] === 1 && value[1] === 0 && value[2] === 0 && value[3] === 1) return value.slice(4);
  }
  return null;
}

export function normalizePages(value) {
  const pages = [];
  let visited = 0;
  function visit(node, context = {}, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 30 || ++visited > 50000) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, context, depth + 1);
      return;
    }
    let page = context.page;
    const width = node.width ?? node.pageWidth;
    const height = node.height ?? node.pageHeight;
    if (!page && Number.isFinite(width) && Number.isFinite(height) && width >= 100 && height >= 100 && width <= 10000 && height <= 10000) {
      if (pages.length >= 24) return;
      page = { width, height, glyphs: [] };
      pages.push(page);
    }
    const offset = translation(node.transform);
    if (!offset) return;
    const next = {
      page,
      x: (context.x || 0) + offset[0],
      y: (context.y || 0) + offset[1],
      font: node.fontKey ?? node.fontFamily ?? context.font,
      size: node.fontSize ?? context.size,
    };
    if (page && Array.isArray(node.glyphs) && Array.isArray(node.xPosition)) {
      const baseline = next.y + (Number.isFinite(node.yPosition) ? node.yPosition : 0);
      if (node.glyphs.length !== node.xPosition.length || node.glyphs.length > 10000 || !Number.isFinite(next.size) || next.size <= 0 || next.size > 300 || next.font == null) return;
      for (let index = 0; index < node.glyphs.length && page.glyphs.length < 15000; index++) {
        const glyph = node.glyphs[index];
        const x = next.x + node.xPosition[index];
        if (!Number.isSafeInteger(glyph) || glyph < 0 || !Number.isFinite(x) || x < 0 || x > page.width || baseline < 0 || baseline > page.height) return;
        page.glyphs.push({ id: glyph, font: String(next.font), x, baseline, size: next.size });
      }
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (!['transform', 'glyphs', 'xPosition'].includes(key)) visit(child, next, depth + 1);
    }
  }
  visit(value);
  return pages.filter((page) => page.glyphs.length >= 20);
}

export function validPage(page) {
  return page && Number.isFinite(page.width) && page.width >= 100 && page.width <= 10000
    && Number.isFinite(page.height) && page.height >= 100 && page.height <= 10000
    && Array.isArray(page.glyphs) && page.glyphs.length >= 20 && page.glyphs.length <= 15000
    && page.glyphs.every((glyph) => Number.isSafeInteger(glyph.id) && glyph.id >= 0 && typeof glyph.font === 'string' && glyph.font.length < 200
      && Number.isFinite(glyph.x) && glyph.x >= 0 && glyph.x <= page.width
      && Number.isFinite(glyph.baseline) && glyph.baseline >= 0 && glyph.baseline <= page.height
      && Number.isFinite(glyph.size) && glyph.size > 0 && glyph.size <= 300);
}

export function validBatches(batches) {
  return Array.isArray(batches) && batches.length <= 6 && batches.every((batch) => batch
    && typeof batch.id === 'string' && batch.id.length <= 100 && typeof batch.book === 'string' && batch.book.length <= 40
    && Array.isArray(batch.pages) && batch.pages.length <= 24 && batch.pages.every(validPage));
}
