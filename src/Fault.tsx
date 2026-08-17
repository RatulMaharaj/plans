/**
 * When something throws.
 *
 * In development a thrown error puts an overlay on the screen. In a packaged
 * app it simply unmounts everything, leaving a white window and no account of
 * what happened — which reads, reasonably, as "the app crashed".
 *
 * This catches it, says what it was, and writes it to the log so it can be read
 * from outside. Nothing is auto-recovered: the buffer is on disk, and pretending
 * to carry on after an unknown failure is how files get damaged.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { api } from "./api";

/** Also catches what escapes React: async rejections, event handlers, plugins. */
export function watchForFaults() {
  const write = (what: string, detail: unknown) => {
    const e = detail instanceof Error ? detail : new Error(String(detail));
    void api
      .perfLog(`\n=== ${what} ${new Date().toISOString()}\n${e.message}\n${e.stack ?? ""}`)
      .catch(() => {});
  };
  window.addEventListener("error", (ev) => write("error", ev.error ?? ev.message));
  window.addEventListener("unhandledrejection", (ev) => write("rejection", ev.reason));
}

type Props = { children: ReactNode };
type State = { error: Error | null };

export class Fault extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    void api
      .perfLog(
        `\n=== render ${new Date().toISOString()}\n${error.message}\n${error.stack ?? ""}\n${info.componentStack ?? ""}`,
      )
      .catch(() => {});
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="fault">
        <p className="fault-line">Something threw.</p>
        <p className="fault-hint">
          Your work is on disk — this is the window, not the file. The details are
          below and in the log.
        </p>
        <pre className="fault-detail">
          {error.message}
          {"\n\n"}
          {error.stack}
        </pre>
        <span className="fault-acts">
          <button className="rail-btn" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button className="rail-btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </span>
      </div>
    );
  }
}
