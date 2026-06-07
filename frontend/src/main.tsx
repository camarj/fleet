import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// NOTE: no React.StrictMode — it double-mounts effects in dev, which would
// create/dispose the xterm instance twice. Re-enable once the terminal init is
// made idempotent if you want StrictMode's other checks.
const container = document.getElementById("root");
if (!container) throw new Error("missing #root");
createRoot(container).render(<App />);
