import { useCallback, useEffect, useRef, useState } from 'react';
import { type KjgxWorkerStatusResponse, api } from '../api.js';

export type KjgxState = 'checking' | 'connected' | 'expired';

/**
 * Single source of truth for the KJGX connection: polls the worker status and re-probes the
 * live session (at most every 5 minutes, or on demand) so the header capsule stays honest.
 */
export function useKjgxConnection(enabled: boolean) {
  const [status, setStatus] = useState<KjgxWorkerStatusResponse | null>(null);
  const [state, setState] = useState<KjgxState>('checking');
  const lastProbeRef = useRef(0);

  const check = useCallback(async (forceProbe = false): Promise<boolean> => {
    try {
      const st = await api.getKjgxWorkerStatus();
      setStatus(st);
      if (!st.session_present) {
        lastProbeRef.current = 0;
        setState('expired');
        return false;
      }
      if (forceProbe || Date.now() - lastProbeRef.current > 5 * 60_000) {
        const probe = await api.probeKjgxWorker();
        lastProbeRef.current = Date.now();
        setState(probe.ok ? 'connected' : 'expired');
        if (!probe.ok) {
          const after = await api.getKjgxWorkerStatus().catch(() => null);
          if (after) setStatus(after);
        }
        return probe.ok;
      }
      setState((prev) => (prev === 'checking' ? 'connected' : prev));
      return true;
    } catch {
      setState((prev) => (prev === 'checking' ? 'expired' : prev));
      return false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void check();
    const t = window.setInterval(() => void check(), 45_000);
    return () => window.clearInterval(t);
  }, [enabled, check]);

  return { state, status, check };
}
