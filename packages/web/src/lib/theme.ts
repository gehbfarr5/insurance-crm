import { useCallback, useEffect, useState } from 'react';

const KEY = 'color-scheme';
export type Scheme = 'light' | 'dark';

function read(): Scheme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function apply(scheme: Scheme) {
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', scheme);
}

/** Light by default; dark is an explicit, persisted override. Keeps the <meta name="color-scheme"> in sync. */
export function useScheme() {
  const [scheme, setScheme] = useState<Scheme>(read);

  useEffect(() => {
    apply(scheme);
  }, [scheme]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY || e.key === null) setScheme(read());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggle = useCallback(() => {
    const next: Scheme = scheme === 'dark' ? 'light' : 'dark';
    try {
      if (next === 'dark') localStorage.setItem(KEY, 'dark');
      else localStorage.removeItem(KEY);
    } catch {
      // Theme still applies for this session even if it cannot be persisted.
    }
    setScheme(next);
  }, [scheme]);

  return { scheme, toggle };
}
