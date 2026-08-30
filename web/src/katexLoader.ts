// Lazy-load KaTeX so the main FileViewer chunk stays light when no
// $…$ / $$…$$ math is present. initialize is one-shot via the module
// promise; callers render each .math node after the markdown HTML lands.

import type Katex from 'katex';

type KatexApi = typeof Katex;

let ready: Promise<KatexApi> | null = null;

export function getKatex(): Promise<KatexApi> {
  if (!ready) {
    ready = Promise.all([
      import('katex'),
      import('katex/dist/katex.min.css'),
    ]).then(([mod]) => mod.default);
  }
  return ready;
}
