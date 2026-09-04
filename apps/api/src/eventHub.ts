import type { Redis } from "ioredis";
import type { LiveEvent } from "@uhc/shared";
import { CHANNELS, subscribe } from "@uhc/core";

type Listener = (event: LiveEvent) => void;

export class EventHub {
  private readonly listeners = new Set<Listener>();

  constructor(private readonly subscriber: Redis) {}

  async start(): Promise<void> {
    await subscribe(this.subscriber, CHANNELS.events, (raw) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(raw) as LiveEvent;
      } catch {
        return;
      }
      for (const listener of this.listeners) listener(event);
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get connections(): number {
    return this.listeners.size;
  }
}
