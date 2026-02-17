export function getFaviconUrl(url) {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`;
  } catch {
    return null;
  }
}

export function getDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url;
  }
}
