import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// NOTE: no React.StrictMode. xterm (the old reason) is gone, but the Core
// connection effect in App.tsx tears down its listeners without disconnecting
// the GatewayClient (it has no disconnect()), so StrictMode's dev double-mount
// would open a second, dangling WebSocket. Enabling StrictMode is its own task:
// give GatewayClient a disconnect() and close it in the effect cleanup first.
const container = document.getElementById("root");
if (!container) throw new Error("missing #root");
createRoot(container).render(<App />);
