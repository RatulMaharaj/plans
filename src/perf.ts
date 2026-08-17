/**
 * A small profiler, in the app.
 *
 * The webview inspector can do all of this and more, but it has to be opened,
 * recorded and read — and the interesting cases here are ambient: a poll that
 * fires every few seconds, a render that happens on every keystroke. This keeps
 * rolling figures for anything worth naming, and the HUD shows them live.
 *
 * Overhead is a Map lookup and a subtraction per sample, so it can be left in.
 */

export type Stat = {
  name: string;
  count: number;
  last: number;
  worst: number;
  total: number;
  /** Samples in the last second, for things that fire on their own. */
  rate: number;
  recent: number[];
};

const stats = new Map<string, Stat>();
const listeners = new Set<() => void>();

function statFor(name: string): Stat {
  let s = stats.get(name);
  if (!s) {
    s = { name, count: 0, last: 0, worst: 0, total: 0, rate: 0, recent: [] };
    stats.set(name, s);
  }
  return s;
}

/** Record one sample, in milliseconds. */
export function sample(name: string, ms: number) {
  const s = statFor(name);
  s.count += 1;
  s.last = ms;
  s.total += ms;
  if (ms > s.worst) s.worst = ms;
  s.recent.push(performance.now());
}

/** Time a block: `const done = start("poll:files"); …; done();` */
export function start(name: string): () => void {
  const t0 = performance.now();
  return () => sample(name, performance.now() - t0);
}

/** Time a promise, keeping its result and its rejection. */
export async function timed<T>(name: string, run: () => Promise<T>): Promise<T> {
  const done = start(name);
  try {
    return await run();
  } finally {
    done();
  }
}

/** Count something that has no duration — a render, an event. */
export function tick(name: string) {
  sample(name, 0);
}

export function snapshot(): Stat[] {
  const now = performance.now();
  const out: Stat[] = [];
  for (const s of stats.values()) {
    s.recent = s.recent.filter((t) => now - t < 1000);
    s.rate = s.recent.length;
    out.push({ ...s, recent: [] });
  }
  return out.sort((a, b) => b.total - a.total);
}

export function reset() {
  stats.clear();
  listeners.forEach((f) => f());
}

/**
 * The long-task observer: anything blocking the main thread for 50ms or more.
 * This is the figure that matters for "the whole app feels slow", since it is
 * exactly what stops the window responding.
 */
export function watchLongTasks() {
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) sample("⚠ long task", entry.duration);
    });
    obs.observe({ entryTypes: ["longtask"] });
    return () => obs.disconnect();
  } catch {
    return () => {};
  }
}
