// Copies package.json's version into manifest.json. Runs from `npm version`, so one command bumps
// both, commits and tags the release.
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = readFileSync('manifest.json', 'utf8');
const updated = manifest.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`);
if (updated === manifest && !manifest.includes(`"version": "${version}"`)) throw new Error('No version field in manifest.json');
writeFileSync('manifest.json', updated);
console.log(`manifest.json version: ${version}`);
