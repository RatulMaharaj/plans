import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Fault, watchForFaults } from "./Fault";

// Anything thrown anywhere ends up in the log, not in a blank window.
watchForFaults();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Fault>
      <App />
    </Fault>
  </React.StrictMode>,
);
