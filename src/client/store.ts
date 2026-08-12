/*
 * A ~50 line reactive store, because the alternative was worse.
 *
 * Before this, ticking a section ran a full DOM sweep: query every row, strip
 * a class off all of them, recompute conflicts, put the class back. That is
 * the shape imperative UI code always collapses into, and it gets wronger
 * every time a new piece of state appears.
 *
 * The rule here is that nothing mutates the DOM in response to an event.
 * Events change state; state changes notify; subscribers render. Subscribing
 * to a *slice* keeps that cheap, so picking a section repaints one row and
 * the grid rather than the whole page.
 */

export type Unsubscribe = () => void;

export interface Store<T> {
  get(): T;
  set(patch: Partial<T> | ((current: T) => Partial<T>)): void;
  /** Fires on every change. Returns an unsubscribe. */
  subscribe(listener: (state: T) => void): Unsubscribe;
  /**
   * Fires only when `select` returns something new, compared with Object.is.
   * Runs once immediately so a subscriber never has to paint itself first.
   */
  watch<S>(select: (state: T) => S, react: (value: S, previous: S) => void): Unsubscribe;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<(state: T) => void>();

  const notify = () => {
    // Copied, so a listener that unsubscribes mid-notify cannot skip another.
    for (const listener of [...listeners]) listener(state);
  };

  return {
    get: () => state,

    set(patch) {
      const next = typeof patch === "function" ? patch(state) : patch;
      // Skip the repaint when nothing actually moved.
      const changed = Object.entries(next).some(
        ([key, value]) => !Object.is(state[key as keyof T], value),
      );
      if (!changed) return;
      state = { ...state, ...next };
      notify();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    watch(select, react) {
      let previous = select(state);
      react(previous, previous);
      return this.subscribe((current) => {
        const value = select(current);
        if (Object.is(value, previous)) return;
        const was = previous;
        previous = value;
        react(value, was);
      });
    },
  };
}

/**
 * Collects unsubscribes so a view's destroy() is one call instead of a list
 * someone will eventually forget to add to.
 */
export class Subscriptions {
  #all: Unsubscribe[] = [];

  add(...unsubscribes: Unsubscribe[]): void {
    this.#all.push(...unsubscribes);
  }

  clear(): void {
    for (const off of this.#all) off();
    this.#all = [];
  }
}
