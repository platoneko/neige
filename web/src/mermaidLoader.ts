// Lazy-load mermaid so the main FileViewer chunk stays light when no
// ```mermaid fences are present. initialize() is one-shot; mermaid.run()
// is called per-pane after the markdown HTML is written.

import type mermaidType from 'mermaid';

type Mermaid = typeof mermaidType;

let ready: Promise<Mermaid> | null = null;

export function getMermaid(): Promise<Mermaid> {
  if (!ready) {
    ready = import('mermaid').then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({
        startOnLoad: false,
        // App shell is dark-only today (see web/src/index.css).
        theme: 'dark',
        // File viewer shows local workspace files; keep the stricter default.
        securityLevel: 'strict',
        fontFamily:
          "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif",
      });
      return mermaid;
    });
  }
  return ready;
}
