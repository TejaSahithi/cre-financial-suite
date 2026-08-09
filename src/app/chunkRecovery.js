const CHUNK_RELOAD_STORAGE_KEY = 'last_chunk_reload_ts';
const CHUNK_RELOAD_QUERY_KEY = '__app_reload';
const CHUNK_RELOAD_COOLDOWN_MS = 10000;

export function isChunkLoadError(error) {
  const message = String(error?.message || '');
  return (
    error?.name === 'ChunkLoadError' ||
    /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk \d+ failed|Failed to load resource/i.test(message)
  );
}

export function recoverFromChunkLoadError() {
  if (typeof window === 'undefined') return false;

  const lastReload = Number(window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY) || 0);
  const now = Date.now();
  if (now - lastReload <= CHUNK_RELOAD_COOLDOWN_MS) {
    return false;
  }

  window.sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, String(now));

  if ('caches' in window) {
    window.caches
      .keys()
      .then((keys) => Promise.all(keys.map((key) => window.caches.delete(key))))
      .catch(() => {});
  }

  const url = new URL(window.location.href);
  url.searchParams.set(CHUNK_RELOAD_QUERY_KEY, String(now));
  window.location.replace(url.toString());
  return true;
}

export function registerChunkLoadRecovery() {
  if (typeof window === 'undefined') return;

  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    recoverFromChunkLoadError();
  });

  window.addEventListener('unhandledrejection', (event) => {
    if (isChunkLoadError(event.reason)) {
      event.preventDefault();
      recoverFromChunkLoadError();
    }
  });
}
