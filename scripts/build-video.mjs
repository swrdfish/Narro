// Renders the store / README demo video from store-assets/video/promo.html:
// narrates the demo sentences with Kokoro, captures every frame in Chrome, then muxes with ffmpeg.
// Needs Google Chrome (or $CHROME) and ffmpeg on PATH. Output goes to store-assets/video/out/.
import { KokoroTTS } from 'kokoro-js';
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve('store-assets/video');
const out = `${dir}/out`;
const work = `${out}/.work`;
const FPS = 30;
const READ = 4; // how many sentences the demo reads aloud
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// A soft ambient bed, synthesized so the video carries no music licence: a slow chord pad
// (Cmaj7 · Am7 · Fmaj7 · G6) with a quiet bell arpeggio and a stereo echo. It never stops:
// - The chord grid is anchored so G resolves to C exactly as Narro starts speaking (`voiceFrom`).
// - Under the voice the pad drops ~8 dB and darkens (low-pass), and the bells fade out; ffmpeg's
//   sidechain compressor then dips it further on each sentence.
// - It opens back up on the first chord change after the voice ends (`voiceTo`).
// - A soft click marks the cursor pressing the Narro icon (`clickAt`).
function writeMusic(path, duration, voiceFrom, voiceTo, clickAt) {
  const rate = 48000;
  const n = Math.ceil(duration * rate);
  const chords = [
    [130.81, 196.0, 329.63, 493.88],
    [110.0, 164.81, 261.63, 392.0],
    [87.31, 130.81, 220.0, 329.63],
    [98.0, 146.83, 246.94, 329.63],
  ];
  const CHORD = 4; // seconds per chord
  const XFADE = 1.5;
  const RAMP = 1.6; // seconds for the duck to settle or release
  const TAU = 2 * Math.PI;
  const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x));
  // Music time: a whole number of 4-chord cycles before voiceFrom, so chord 0 (C) lands on it.
  const origin = voiceFrom - 4 * CHORD * Math.ceil(voiceFrom / (4 * CHORD));
  const release = voiceFrom + CHORD * Math.ceil((voiceTo + 0.4 - voiceFrom) / CHORD);
  const duck = (t) => smooth((t - (voiceFrom - RAMP)) / RAMP) * (1 - smooth((t - (release - RAMP)) / RAMP));
  const lp = 1 - Math.exp((-TAU * 450) / rate); // one-pole low-pass at ~450 Hz
  let lpL = 0, lpR = 0;

  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const tm = t - origin;
    const u = duck(t);
    const k = Math.floor(tm / CHORD);
    const into = tm - k * CHORD;
    // Crossfade from the previous chord over the first XFADE seconds of each one.
    const w = into >= XFADE ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * into) / XFADE);
    let l = 0, r = 0;
    for (const [chord, gain] of [[chords[k % 4], w], [chords[(k + 3) % 4], 1 - w]]) {
      if (gain === 0) continue;
      for (const f of chord) {
        const swell = 0.8 + 0.2 * Math.sin(TAU * 0.13 * t + f);
        l += gain * swell * (Math.sin(TAU * f * 0.9985 * t) + 0.25 * Math.sin(TAU * f * 2 * t));
        r += gain * swell * (Math.sin(TAU * f * 1.0015 * t) + 0.25 * Math.sin(TAU * f * 2 * t + 0.7));
      }
    }
    // Under the voice: blend toward the low-passed pad and turn it down.
    lpL += lp * (l - lpL);
    lpR += lp * (r - lpR);
    const padGain = 1 - 0.6 * u;
    l = padGain * (l + u * (lpL - l));
    r = padGain * (r + u * (lpR - r));
    // Bell arpeggio: the chord's upper notes an octave up, one every half second.
    const step = Math.floor(tm / 0.5);
    const since = tm - step * 0.5;
    const chord = chords[Math.floor((step * 0.5) / CHORD) % 4];
    const bf = chord[1 + (step % 3)] * 2;
    const bell = (1 - u) ** 2 * Math.exp(-since * 2.2) * Math.min(1, since * 200)
      * (Math.sin(TAU * bf * t) + 0.15 * Math.sin(TAU * bf * 3 * t));
    l += 0.9 * bell * (step % 2 ? 0.6 : 1);
    r += 0.9 * bell * (step % 2 ? 1 : 0.6);
    const env = smooth(t / 1.5) * (1 - smooth((t - (duration - 3)) / 3)); // fade in and out
    L[i] = l * env;
    R[i] = r * env;
  }
  // Stereo echo for a little space.
  for (const [buf, d] of [[L, 0.37], [R, 0.43]]) {
    const off = Math.round(d * rate);
    for (let i = off; i < n; i++) buf[i] += 0.35 * buf[i - off];
  }
  // Level: set by the intro at full volume (about -24 dBFS RMS), not by loudnorm, so the ducking survives.
  let sum = 0, count = 0;
  for (let i = Math.round(1.5 * rate); i < Math.round((voiceFrom - RAMP) * rate); i++, count++) sum += L[i] ** 2 + R[i] ** 2;
  const scale = 0.063 / Math.sqrt(sum / (2 * count));
  // The click: a short filtered tick, like a trackpad press.
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const c0 = Math.round(clickAt * rate);
  for (let i = 0; i < 0.05 * rate; i++) {
    const s = i / rate;
    const v = 0.18 * noise() * Math.exp(-s * 500) + 0.22 * Math.sin(TAU * 1700 * s) * Math.exp(-s * 140);
    L[c0 + i] += v / scale;
    R[c0 + i] += v / scale;
  }

  const pcm = Buffer.alloc(44 + n * 4);
  pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + n * 4, 4); pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(2, 22);
  pcm.writeUInt32LE(rate, 24); pcm.writeUInt32LE(rate * 4, 28); pcm.writeUInt16LE(4, 32); pcm.writeUInt16LE(16, 34);
  pcm.write('data', 36); pcm.writeUInt32LE(n * 4, 40);
  const clip = (x) => Math.round(32767 * Math.max(-1, Math.min(1, x * scale)));
  for (let i = 0; i < n; i++) {
    pcm.writeInt16LE(clip(L[i]), 44 + i * 4);
    pcm.writeInt16LE(clip(R[i]), 46 + i * 4);
  }
  writeFileSync(path, pcm);
}

rmSync(work, { recursive: true, force: true });
mkdirSync(`${work}/frames`, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--allow-file-access-from-files', '--hide-scrollbars', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
const url = `file://${dir}/promo.html`;
await page.goto(url);
const sentences = (await page.$$eval('.s', (els) => els.map((e) => e.textContent))).slice(0, READ);

// Narration: one clip per sentence, so the highlight can follow each one exactly.
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
const durations = [];
for (const [i, text] of sentences.entries()) {
  const audio = await tts.generate(text, { voice: 'af_heart' });
  audio.save(`${work}/s${i}.wav`);
  durations.push(audio.audio.length / audio.sampling_rate);
}

await page.evaluateOnNewDocument((d) => { window.TIMING = { start: 6.2, gap: 0.3, durations: d }; }, durations);
await page.goto(url, { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);
const { duration, starts, click } = await page.evaluate(() => ({
  duration: window.DURATION, starts: window.STARTS, click: window.CLICK,
}));

const frames = Math.ceil(duration * FPS);
for (let i = 0; i < frames; i++) {
  await page.evaluate((t) => window.render(t), i / FPS);
  await page.screenshot({ path: `${work}/frames/f${String(i).padStart(5, '0')}.png` });
}
await browser.close();

const ffmpeg = (...args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
writeMusic(`${work}/music.wav`, duration, starts[0][0], starts.at(-1)[1], click);
const delays = starts.map(([t], i) => `[${i}]adelay=${Math.round(t * 1000)}:all=1[a${i}]`).join(';');
const mix = starts.map((_, i) => `[a${i}]`).join('');
ffmpeg(
  ...sentences.flatMap((_, i) => ['-i', `${work}/s${i}.wav`]),
  '-i', `${work}/music.wav`,
  '-filter_complex',
  `${delays};${mix}amix=inputs=${sentences.length}:normalize=0,apad,atrim=0:${duration},loudnorm=I=-16:TP=-1.5,aresample=48000,aformat=channel_layouts=stereo,asplit[voice][key];` +
  // The voice also keys a compressor on the music, so the bed dips a little more on each sentence.
  `[${sentences.length}]aformat=channel_layouts=stereo[music];` +
  `[music][key]sidechaincompress=threshold=0.03:ratio=3:attack=60:release=700[bed];` +
  `[voice][bed]amix=inputs=2:normalize=0,alimiter=limit=0.89[out]`,
  '-map', '[out]', `${work}/narration.wav`,
);
ffmpeg(
  '-framerate', String(FPS), '-i', `${work}/frames/f%05d.png`, '-i', `${work}/narration.wav`,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k',
  '-shortest', '-movflags', '+faststart', `${out}/narro-demo-1080p.mp4`,
);
// Smaller copy for the README (GitHub caps video uploads at 10 MB on free plans).
ffmpeg(
  '-i', `${out}/narro-demo-1080p.mp4`, '-vf', 'scale=1280:-2',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
  '-movflags', '+faststart', `${out}/narro-demo-readme-720p.mp4`,
);
rmSync(work, { recursive: true, force: true });
console.log(`Wrote ${out}/narro-demo-1080p.mp4 and narro-demo-readme-720p.mp4 (${duration.toFixed(1)}s)`);
