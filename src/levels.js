// Loudness over time for the player's visualizer, computed once per clip from its decoded audio:
// the offscreen document band-pass filters a clip into a few bands, and this turns each band into
// a level per frame, so the bars follow the voice without touching the audio as it plays.

export const LEVEL_FPS = 30;
// Band centres (Hz), low to high, across the range where speech has its energy.
export const LEVEL_BANDS = [250, 600, 1200, 2400, 4800];

/**
 * channels: one Float32Array per band, all at sampleRate.
 * Returns { fps, bands, data } with data[frame * bands + band] in 0..255: the band's RMS in each
 * frame on a 45 dB scale up to the clip's loudest band-frame, so quiet clips still move the bars.
 */
export function bandLevels(channels, sampleRate, fps = LEVEL_FPS) {
  const bands = channels.length;
  const frameLength = Math.max(1, Math.round(sampleRate / fps));
  const frames = Math.ceil((channels[0]?.length || 0) / frameLength);
  const rms = new Float32Array(frames * bands);
  let loudest = 0;
  for (let band = 0; band < bands; band++) {
    const samples = channels[band];
    for (let frame = 0; frame < frames; frame++) {
      const start = frame * frameLength;
      const end = Math.min(samples.length, start + frameLength);
      let sum = 0;
      for (let i = start; i < end; i++) sum += samples[i] * samples[i];
      const value = Math.sqrt(sum / Math.max(1, end - start));
      rms[frame * bands + band] = value;
      if (value > loudest) loudest = value;
    }
  }
  const data = new Array(rms.length).fill(0);
  if (loudest > 0) {
    for (let i = 0; i < rms.length; i++) {
      const db = 20 * Math.log10(rms[i] / loudest || 1e-9); // 0 at the loudest, negative below
      data[i] = Math.round(Math.min(1, Math.max(0, 1 + db / 45)) * 255);
    }
  }
  return { fps, bands, data };
}

/** The bars' heights (0..1) at `time` seconds into the clip. */
export function levelsAt(levels, time) {
  const { fps, bands, data } = levels;
  const frame = Math.floor(time * fps);
  if (frame < 0 || (frame + 1) * bands > data.length) return new Array(bands).fill(0);
  return Array.from({ length: bands }, (_, band) => data[frame * bands + band] / 255);
}
