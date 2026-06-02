export function devLog(...args) {
  if (import.meta.env.DEV) console.log(...args);
}

export function devWarn(...args) {
  if (import.meta.env.DEV) console.warn(...args);
}

export function devTable(...args) {
  if (import.meta.env.DEV) console.table(...args);
}
