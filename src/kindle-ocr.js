import { createWorker, PSM } from 'tesseract.js';
import { ocrParagraphs } from './kindle-text.js';

const cache = new Map();
let workerPromise;
let activeJob;
let idleTimer;

function getWorker() {
  workerPromise ??= createWorker('eng', 1, {
    workerPath: chrome.runtime.getURL('ocr/worker.min.js'),
    corePath: chrome.runtime.getURL('ocr'),
    langPath: chrome.runtime.getURL('ocr'),
    workerBlobURL: false,
    cacheMethod: 'none',
    errorHandler: () => {},
  }).then(async (worker) => {
    try {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, user_defined_dpi: '150' });
      return worker;
    } catch (error) {
      await worker.terminate();
      throw error;
    }
  });
  return workerPromise;
}

function disposeWorker() {
  const previous = workerPromise;
  workerPromise = null;
  previous?.then((worker) => worker.terminate()).catch(() => {});
}

async function loadImage(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > 24 * 1024 * 1024 || !/^data:image\/(png|jpeg);base64,/.test(dataUrl)) throw new Error('Invalid Kindle page image.');
  // Not new Image() + decode(): decode() waits for a rendering opportunity, which an offscreen
  // document never gets, so it never resolves there.
  const image = await createImageBitmap(await (await fetch(dataUrl)).blob());
  if (image.width * image.height > 32000000) throw new Error('Kindle page image is too large. Zoom out and retry.');
  return image;
}

async function recognizeImage(dataUrl, crop, signal) {
  signal.throwIfAborted();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${JSON.stringify(crop)}:${dataUrl}`));
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (cache.has(key)) return cache.get(key);
  const image = await loadImage(dataUrl);
  signal.throwIfAborted();
  const region = crop || { left: 0, top: 0, width: image.width, height: image.height };
  if (region.left < 0 || region.top < 0 || region.width < 1 || region.height < 1 || region.left + region.width > image.width + 1 || region.top + region.height > image.height + 1) throw new Error('Kindle page moved. Please retry.');
  const scale = Math.min(2, 2400 / Math.max(region.width, region.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(region.width * scale);
  canvas.height = Math.round(region.height * scale);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, region.left, region.top, region.width, region.height, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let brightness = 0;
  let samples = 0;
  for (let index = 0; index < pixels.length; index += 400) {
    brightness += (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
    samples++;
  }
  if (brightness / samples < 128) {
    context.filter = 'invert(1)';
    context.drawImage(image, region.left, region.top, region.width, region.height, 0, 0, canvas.width, canvas.height);
  }
  const worker = await getWorker();
  signal.throwIfAborted();
  const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
  signal.throwIfAborted();
  const result = { paragraphs: ocrParagraphs(data, scale), width: region.width, height: region.height };
  cache.set(key, result);
  while (cache.size > 6) cache.delete(cache.keys().next().value);
  return result;
}

export function cancelKindle({ tabId, requestId }) {
  if (activeJob?.tabId === tabId && activeJob.requestId === requestId) activeJob.cancel();
}

export async function recognizeKindle({ images, screenshot, viewport, tabId, requestId }) {
  if (activeJob) throw new Error('Kindle OCR is still finishing. Please retry in a moment.');
  if (!Array.isArray(images) || !images.length || images.length > 4) throw new Error('Invalid Kindle page count.');
  clearTimeout(idleTimer);
  const controller = new AbortController();
  let rejectCancellation;
  const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
  const job = {
    tabId, requestId,
    cancel() {
      controller.abort();
      rejectCancellation(new Error('Kindle extraction cancelled.'));
    },
  };
  activeJob = job;
  let deadline;
  try {
    const work = async () => {
      const capture = screenshot ? await loadImage(screenshot) : null;
      const results = [];
      for (const image of images) {
        let crop;
        if (!image.dataUrl) {
          if (!capture || !viewport?.width || !viewport?.height) throw new Error('Missing Kindle screenshot.');
          crop = {
            left: image.rect.left * capture.width / viewport.width,
            top: image.rect.top * capture.height / viewport.height,
            width: image.rect.width * capture.width / viewport.width,
            height: image.rect.height * capture.height / viewport.height,
          };
        }
        const result = await recognizeImage(image.dataUrl || screenshot, crop, controller.signal);
        results.push({ ...result, source: 'ocr' });
      }
      return { pages: results };
    };
    return await Promise.race([
      work(),
      cancellation,
      new Promise((_, reject) => { deadline = setTimeout(() => {
        controller.abort();
        reject(new Error('Kindle OCR timed out. Try a smaller page or larger font.'));
      }, 90000); }),
    ]);
  } catch (error) {
    controller.abort();
    disposeWorker();
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(deadline);
    if (activeJob === job) {
      activeJob = null;
      idleTimer = setTimeout(disposeWorker, 120000);
    }
  }
}
