export const KINDLE_HOSTS = ['read.amazon.in', 'read.amazon.com', 'read.amazon.co.uk', 'read.amazon.ca', 'read.amazon.com.au', 'read.amazon.co.jp', 'read.amazon.de', 'read.amazon.fr', 'read.amazon.it', 'read.amazon.es', 'read.amazon.com.br', 'read.amazon.com.mx'];

export function isKindleUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && KINDLE_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}
