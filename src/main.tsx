import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Fault, watchForFaults } from "./Fault";
import { startAnalytics, track } from "./analytics";
import { loadSettings } from "./settings";

// Anything thrown anywhere ends up in the log, not in a blank window.
watchForFaults();

// Before the first render, so the preference is honoured from the first event
// rather than from whenever App happens to mount. Off means nothing starts.
startAnalytics(loadSettings().telemetry);
track("app_opened");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Fault>
      <App />
    </Fault>
  </React.StrictMode>,
);
