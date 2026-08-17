/**
 * The profiler, on screen. ⌘⌃P.
 *
 * Rolling figures for the things that fire on their own — polls, IPC calls,
 * renders — plus long tasks, which are what actually make a window feel stuck.
 * Sorted by total time spent, so the worst offender is always the top line.
 */
import { useEffect, useState } from "react";
import { api } from "./api";
import { reset, snapshot, watchLongTasks, type Stat } from "./perf";

/** One line per figure, tab separated, so it reads plainly in a terminal. */
function asLines(rows: Stat[]): string {
  const stamp = new Date().toLocaleTimeString();
  return [
    `--- ${stamp}`,
    ...rows.map(
      (s) =>
        [
          s.name.padEnd(28),
          `n=${s.count}`.padEnd(9),
          `rate=${s.rate}/s`.padEnd(11),
          `last=${s.last.toFixed(1)}`.padEnd(12),
          `worst=${s.worst.toFixed(1)}`.padEnd(14),
          `total=${Math.round(s.total)}`,
        ].join(" "),
    ),
  ].join("\n");
}

export function PerfHud({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Stat[]>([]);

  const [logging, setLogging] = useState(true);

  useEffect(() => {
    const stop = watchLongTasks();
    const t = setInterval(() => setRows(snapshot()), 500);
    return () => {
      clearInterval(t);
      stop();
    };
  }, []);

  /**
   * While open, the figures go to /tmp/plans-perf.log every two seconds as
   * well as to the screen — so they can be read from outside the app, without
   * anyone having to transcribe a table.
   */
  useEffect(() => {
    if (!logging) return;
    const t = setInterval(() => {
      const rows = snapshot();
      if (rows.length) void api.perfLog(asLines(rows));
    }, 2000);
    return () => clearInterval(t);
  }, [logging]);

  return (
    <div className="perf">
      <div className="perf-head">
        <span className="tag">Profiler</span>
        <span className="perf-acts">
          <button className="act" onClick={reset}>
            Reset
          </button>
          <button
            className={`act ${logging ? "" : "quiet"}`}
            title="/tmp/plans-perf.log"
            onClick={() => setLogging((v) => !v)}
          >
            {logging ? "Logging" : "Log off"}
          </button>
          <button className="act" onClick={onClose}>
            Close
          </button>
        </span>
      </div>
      <table className="perf-table">
        <thead>
          <tr>
            <th>What</th>
            <th>n</th>
            <th>/s</th>
            <th>last</th>
            <th>worst</th>
            <th>total</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="perf-none">
                Nothing recorded yet — use the app for a moment.
              </td>
            </tr>
          )}
          {rows.map((s) => (
            <tr key={s.name} className={s.worst > 50 ? "bad" : ""}>
              <td>{s.name}</td>
              <td>{s.count}</td>
              <td>{s.rate || ""}</td>
              <td>{s.last.toFixed(1)}</td>
              <td>{s.worst.toFixed(1)}</td>
              <td>{Math.round(s.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="perf-note">
        Milliseconds. A long task over ~50ms is a frame the window could not
        answer in. Figures are written to /tmp/plans-perf.log every 2s.
      </p>
    </div>
  );
}
