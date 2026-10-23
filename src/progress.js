// Turns per-file download events (Transformers.js progress_callback shape) into one status line.

// Below this many bytes in view, only small files (tokenizer, configs) have started; a percentage
// would read as nearly done before the model weights begin.
const MIN_BYTES_FOR_PERCENT = 5 * 1024 * 1024;

/**
 * Returns a progress callback that reports "Downloading <label>…" and then "… N%" via `onStatus`.
 * The percentage only goes up, except that it may drop once when a new file joins the download
 * (the total grows), so it can't get stuck at 99%. It stays below 100% until loading finishes.
 */
export function downloadProgress(label, onStatus) {
  const files = new Map(); // file -> { loaded, total }
  let shown = null;
  let floor = -1;
  const show = (text) => {
    if (text !== shown) onStatus((shown = text));
  };
  return (event) => {
    const { status, file } = event;
    if (!file) return;
    if (status === 'progress' && event.total) {
      if (!files.has(file)) floor = -1; // the total just grew; let the percentage restart from there
      files.set(file, { loaded: event.loaded, total: event.total });
    } else if (status === 'done' && files.has(file)) {
      files.get(file).loaded = files.get(file).total;
    } else {
      return;
    }
    let loaded = 0;
    let total = 0;
    for (const entry of files.values()) {
      loaded += entry.loaded;
      total += entry.total;
    }
    if (total < MIN_BYTES_FOR_PERCENT) return show(`Downloading ${label}…`);
    floor = Math.min(99, Math.max(floor, Math.round((loaded / total) * 100)));
    show(`Downloading ${label}… ${floor}%`);
  };
}
