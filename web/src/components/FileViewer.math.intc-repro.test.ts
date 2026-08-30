import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { renderMarkdownWithToc } from './FileViewer';
import { getKatex } from '../katexLoader';

const excerpt = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures/intc-math-excerpt.md'),
  'utf8',
);

describe('INTC-style \\( \\) / \\[ \\] math', () => {
  it('emits math placeholders for paren/bracket delimiters', () => {
    const { html } = renderMarkdownWithToc(excerpt);

    expect(html).toContain('<span class="math math-inline">E[P_f]</span>');
    expect(html).toContain(
      `<span class="math math-inline">${String.raw`P_{\text{ref}}`}</span>`,
    );
    expect(html).toContain('<div class="math math-display">');
    expect(html).toContain(String.raw`L = P_{\text{cpu},L}`);
    expect(html).not.toContain('\\(E[P_f]\\)');
    expect(html).not.toMatch(/\\\[\s*L = P_/);

    // Currency stays literal.
    expect(html).toContain('$95');
    expect(html).toContain('$89.5');
  });

  it('KaTeX-renders every placeholder from the excerpt', async () => {
    const { html } = renderMarkdownWithToc(excerpt);
    const root = document.createElement('div');
    root.innerHTML = html;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('.math'));
    expect(nodes.length).toBeGreaterThan(8);

    const katex = await getKatex();
    const failures: string[] = [];
    for (const node of nodes) {
      const tex = node.textContent ?? '';
      try {
        node.innerHTML = katex.renderToString(tex, {
          displayMode: node.classList.contains('math-display'),
          throwOnError: true,
          trust: false,
        });
      } catch (e) {
        failures.push(`${tex} :: ${(e as Error).message}`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
    expect(root.querySelectorAll('.katex').length).toBe(nodes.length);
  });
});
