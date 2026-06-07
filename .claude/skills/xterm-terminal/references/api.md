# @xterm/xterm 6 — API surface used in this project

Package: `@xterm/xterm@6.0.0`
Fit addon: `@xterm/addon-fit@0.11.0`

> The old `xterm` package is DEPRECATED. Always use `@xterm/xterm`.

Official docs: https://xtermjs.org/
GitHub: https://github.com/xtermjs/xterm.js

---

## Imports

```ts
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";  // required — without this the terminal renders blank
```

## Terminal constructor

```ts
new Terminal(options?: ITerminalOptions)
```

Options used in TerminalPanel:

| Option | Type | Value |
|---|---|---|
| `convertEol` | boolean | `true` — converts `\n` to `\r\n` automatically |
| `fontSize` | number | `13` |
| `fontFamily` | string | `"Menlo, Monaco, monospace"` |
| `theme` | ITheme | `{ background: "#0d1117", foreground: "#c9d1d9" }` |

## Core methods

```ts
term.loadAddon(addon: ITerminalAddon): void
// Load an addon before opening. Call before term.open().

term.open(element: HTMLElement): void
// Attach to a DOM element. Element must be mounted and have dimensions.

term.write(data: string | Uint8Array): void
// Write text without newline. For streaming deltas.

term.writeln(data: string | Uint8Array): void
// Write text followed by \n (converted to \r\n when convertEol=true).

term.dispose(): void
// Release all resources. Call in useEffect cleanup.
```

## FitAddon

```ts
const fit = new FitAddon();
term.loadAddon(fit);
term.open(el);
fit.fit();  // resize terminal to fill the container
```

Call `fit.fit()` on:
- After `term.open()` (initial size)
- On `window.resize` events
- Any time the container dimensions change

## Event subscription pattern (React)

```ts
useEffect(() => {
  if (!containerRef.current) return;
  const term = new Terminal({ ... });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(containerRef.current);
  fit.fit();
  termRef.current = term;

  const onResize = () => fit.fit();
  window.addEventListener("resize", onResize);

  return () => {
    window.removeEventListener("resize", onResize);
    term.dispose();
    termRef.current = null;
  };
}, []); // empty deps — create once per mount
```

## Notes on React usage

- The terminal is **imperative** — store it in a `useRef<Terminal | null>`, not state.
- Never re-create the terminal on re-renders. The `[]` dependency array on the creation `useEffect` ensures this.
- The container `<div>` must have explicit height (CSS) or the terminal will have zero height and `fit.fit()` will produce zero columns/rows.

## Addons not yet used (for reference)

- `@xterm/addon-search` — in-terminal text search
- `@xterm/addon-web-links` — clickable URLs
- `@xterm/addon-canvas` — Canvas renderer (performance)
- `@xterm/addon-webgl` — WebGL renderer (fastest)
- `@xterm/addon-attach` — attach to a raw WebSocket (not used — the Gateway translates frames)

Official addon list: https://github.com/xtermjs/xterm.js#addons
