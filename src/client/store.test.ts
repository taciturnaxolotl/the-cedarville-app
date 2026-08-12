import { describe, expect, test } from "bun:test";
import { createStore, Subscriptions } from "./store";

describe("store", () => {
  test("merges a patch and notifies", () => {
    const store = createStore({ term: "", picked: new Set<string>() });
    const seen: string[] = [];
    store.subscribe((s) => seen.push(s.term));

    store.set({ term: "2026FA" });
    expect(store.get().term).toBe("2026FA");
    expect(seen).toEqual(["2026FA"]);
  });

  test("accepts a function patch that reads current state", () => {
    const store = createStore({ count: 1 });
    store.set((s) => ({ count: s.count + 1 }));
    expect(store.get().count).toBe(2);
  });

  // Repainting on a no-op change is how a reactive layer becomes slower than
  // the imperative code it replaced.
  test("an unchanged value notifies nobody", () => {
    const store = createStore({ term: "2026FA" });
    let calls = 0;
    store.subscribe(() => calls++);

    store.set({ term: "2026FA" });
    expect(calls).toBe(0);

    store.set({ term: "2026SU" });
    expect(calls).toBe(1);
  });

  test("watch runs once immediately, then only on real change", () => {
    const store = createStore({ term: "2026FA", other: 1 });
    const seen: string[] = [];
    store.watch(
      (s) => s.term,
      (t) => seen.push(t),
    );

    expect(seen).toEqual(["2026FA"]);

    // A change to an unrelated slice must not wake this watcher.
    store.set({ other: 2 });
    expect(seen).toEqual(["2026FA"]);

    store.set({ term: "2026SU" });
    expect(seen).toEqual(["2026FA", "2026SU"]);
  });

  test("watch hands over the previous value", () => {
    const store = createStore({ n: 1 });
    const pairs: [number, number][] = [];
    store.watch(
      (s) => s.n,
      (now, before) => pairs.push([now, before]),
    );

    store.set({ n: 2 });
    store.set({ n: 3 });
    expect(pairs).toEqual([
      [1, 1],
      [2, 1],
      [3, 2],
    ]);
  });

  test("unsubscribing stops the notifications", () => {
    const store = createStore({ n: 0 });
    let calls = 0;
    const off = store.subscribe(() => calls++);

    store.set({ n: 1 });
    off();
    store.set({ n: 2 });
    expect(calls).toBe(1);
  });

  // A listener that tears itself down mid-notify must not cause the loop to
  // skip whoever came after it.
  test("a listener unsubscribing during notify does not skip others", () => {
    const store = createStore({ n: 0 });
    const order: string[] = [];
    const off = store.subscribe(() => {
      order.push("first");
      off();
    });
    store.subscribe(() => order.push("second"));

    store.set({ n: 1 });
    expect(order).toEqual(["first", "second"]);
  });
});

describe("Subscriptions", () => {
  test("clears everything it collected, once", () => {
    const store = createStore({ n: 0 });
    let calls = 0;
    const subs = new Subscriptions();
    subs.add(
      store.subscribe(() => calls++),
      store.subscribe(() => calls++),
    );

    store.set({ n: 1 });
    expect(calls).toBe(2);

    subs.clear();
    store.set({ n: 2 });
    expect(calls).toBe(2);

    // Clearing twice must not throw or re-run anything.
    subs.clear();
    expect(calls).toBe(2);
  });
});
