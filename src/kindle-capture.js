import { isKindleUrl } from './kindle-data.js';

export async function captureKindle(msg, sender, chromeApi = chrome) {
  if (!sender.tab || sender.frameId !== 0 || !isKindleUrl(sender.url)) throw new Error('Kindle capture is only available in the Kindle reader.');
  const { viewport, images } = msg;
  if (!viewport || ![viewport.width, viewport.height].every((value) => Number.isFinite(value) && value >= 100 && value <= 10000)) throw new Error('Invalid Kindle viewport.');
  if (!Array.isArray(images) || !images.length || images.length > 4) throw new Error('Invalid Kindle page count.');
  for (const image of images) {
    const rect = image?.rect;
    if (!rect || !['left', 'top', 'width', 'height'].every((key) => Number.isFinite(rect[key])) || rect.left < 0 || rect.top < 0 || rect.width <= 0 || rect.height <= 0 || rect.left + rect.width > viewport.width + 1 || rect.top + rect.height > viewport.height + 1) throw new Error('Invalid Kindle page region.');
    if (image.dataUrl != null && (typeof image.dataUrl !== 'string' || image.dataUrl.length > 24 * 1024 * 1024 || !/^data:image\/(png|jpeg);base64,/.test(image.dataUrl))) throw new Error('Invalid Kindle image.');
  }
  let screenshot;
  if (images.some((image) => !image.dataUrl)) {
    const checkActive = async () => {
      const [active] = await chromeApi.tabs.query({ active: true, windowId: sender.tab.windowId });
      if (active?.id !== sender.tab.id || active.url !== sender.url) throw new Error('Keep the Kindle tab active while its page is being read.');
    };
    await checkActive();
    screenshot = await chromeApi.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
    await checkActive();
  }
  return { images, viewport, screenshot };
}
