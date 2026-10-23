// Fills in the header's GitHub star count. Cached for an hour to stay well inside GitHub's API
// limits; if the count can't be fetched, the button just shows the GitHub mark.
const REPO = 'swrdfish/Narro';
const CACHE_KEY = 'narro-github-stars';
const CACHE_MS = 60 * 60 * 1000;

const link = document.querySelector('.gh');
const stars = link.querySelector('.gh-stars');
const count = link.querySelector('.gh-count');

const format = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n));

function showStars(n) {
  count.textContent = format(n);
  stars.hidden = false;
  link.setAttribute('aria-label', `Narro on GitHub, ${n} ${n === 1 ? 'star' : 'stars'}`);
  link.title = `${n} ${n === 1 ? 'star' : 'stars'} on GitHub`;
}

async function load() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (cached && Date.now() - cached.time < CACHE_MS) return showStars(cached.stars);
  } catch {
    // storage unavailable: just fetch
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return;
    const { stargazers_count: n } = await res.json();
    if (!Number.isInteger(n)) return;
    showStars(n);
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ stars: n, time: Date.now() }));
    } catch {}
  } catch {
    // offline or blocked: keep the plain GitHub mark
  }
}

load();
