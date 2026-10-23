// Builds the landing page (site/) into site-dist/, copying in the logo, icons and screenshots so
// they live in one place in the repository. Published to GitHub Pages by .github/workflows/pages.yml.
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const out = 'site-dist';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync('site', out, { recursive: true });
for (const [from, to] of [
  ['icons/narro.svg', 'narro.svg'],
  ['icons/icon-32.png', 'icon-32.png'],
  ['icons/icon-128.png', 'icon-128.png'],
  ['docs/player.png', 'player.png'],
  ['docs/popup.png', 'popup.png'],
]) {
  cpSync(from, `${out}/${to}`);
}
console.log(`Built the landing page into ${out}/`);
