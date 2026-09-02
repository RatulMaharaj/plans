/**
 * The reader's entry point.
 *
 * Built by `vite build --mode share` into `server/public`, which the server
 * serves at `/` and `/{id}`. It is the app's own rendering half and nothing
 * else: no rail, no tree, no repository, no session — a public page is
 * public, and has nothing to sign into.
 */
import React, { Component, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { Page } from "./Page";
import { applySettings, loadSettings } from "../settings";
import "../App.css";

// The reader's own origin has no settings file and no one to have saved one,
// so this is the app's defaults: its paper, its reading face, its measure.
applySettings(loadSettings());

/**
 * Not the app's `Fault`: that one writes to the Tauri log and tells the reader
 * their work is safe on disk, and neither sentence is true here. A public page
 * that throws owes its reader one honest line instead of a white screen.
 */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="share-gone">
        <h1>This page could not be drawn</h1>
        <p>The plan is still there. Reloading is worth a try.</p>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Boundary>
      <Page />
    </Boundary>
  </React.StrictMode>,
);
