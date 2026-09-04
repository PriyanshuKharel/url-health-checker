'use client';

import { useEffect, useRef, useState } from 'react';
import type { SseMessage } from '@uhc/shared';

export type LiveState = 'connecting' | 'live' | 'reconnecting';

interface Handlers {
  onMessage: (message: SseMessage) => void;
  /** Called on every (re)connect. Callers re-fetch the REST snapshot here. */
  onConnect: () => void;
}

/**
 * Thin EventSource wrapper. EventSource reconnects on its own after a drop; the
 * onConnect callback is what makes reconnects *correct* by re-syncing from the API.
 */
export function useLiveEvents(url: string, handlers: Handlers): LiveState {
  const [state, setState] = useState<LiveState>('connecting');
  const handlersRef = useRef(handlers);

  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const source = new EventSource(url);
    source.onopen = () => {
      setState('live');
      handlersRef.current.onConnect();
    };
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        handlersRef.current.onMessage(JSON.parse(event.data) as SseMessage);
      } catch {
        /* ignore malformed frames */
      }
    };
    source.onerror = () => setState('reconnecting');
    return () => source.close();
  }, [url]);

  return state;
}
