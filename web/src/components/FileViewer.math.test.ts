import { describe, it, expect } from 'vitest';
import { renderMarkdownWithToc } from './FileViewer';
import { getKatex } from '../katexLoader';

describe('renderMarkdownWithToc math delimiters', () => {
  it('turns inline $…$ into a math-inline placeholder with escaped TeX', () => {
    const { html } = renderMarkdownWithToc('Einstein: $E=mc^2$ cool');
    expect(html).toContain('<span class="math math-inline">E=mc^2</span>');
    expect(html).toContain('Einstein:');
    expect(html).toContain('cool');
  });

  it('turns block $$…$$ into a math-display placeholder', () => {
    const src = ['# Title', '', '$$', String.raw`\int_0^1 x\,dx`, '$$', ''].join('\n');
    const { html, headings } = renderMarkdownWithToc(src);
    expect(headings.map((h) => h.text)).toEqual(['Title']);
    expect(html).toContain('<div class="math math-display">');
    expect(html).toContain(String.raw`\int_0^1 x\,dx`);
    expect(html).not.toContain('$$');
  });

  it('escapes HTML-sensitive characters inside TeX placeholders', () => {
    const { html } = renderMarkdownWithToc('cmp $a<b$ end');
    expect(html).toContain('<span class="math math-inline">a&lt;b</span>');
    expect(html).not.toContain('>a<b<');
  });

  it('leaves $ inside fenced code blocks alone', () => {
    const src = ['```ts', 'const price = "$5";', '```'].join('\n');
    const { html } = renderMarkdownWithToc(src);
    expect(html).toContain('language-ts');
    expect(html).not.toContain('class="math');
    expect(html).toContain('$5');
  });

  it('leaves $ inside inline code alone', () => {
    const { html } = renderMarkdownWithToc('use `$x$` in code');
    expect(html).toContain('<code>');
    expect(html).not.toContain('class="math');
  });

  it('does not treat bare currency like $5 as math', () => {
    const { html } = renderMarkdownWithToc('It costs $5 today');
    expect(html).not.toContain('class="math');
    expect(html).toContain('$5');
  });

  it('supports one-line $$…$$ inside a paragraph as display math', () => {
    const { html } = renderMarkdownWithToc('see $$x^2$$ here');
    expect(html).toContain('<span class="math math-display">x^2</span>');
  });

  it('turns \\(…\\) into math-inline (before marked escape strips the backslash)', () => {
    const { html } = renderMarkdownWithToc(String.raw`mid \(E[P_f]\) end`);
    expect(html).toContain('<span class="math math-inline">E[P_f]</span>');
    expect(html).not.toContain('\\(E[P_f]\\)');
  });

  it('turns block \\[…\\] into math-display', () => {
    const src = ['', '\\[', String.raw`L = P_{\text{cpu},L}`, '\\]', ''].join('\n');
    const { html } = renderMarkdownWithToc(src);
    expect(html).toContain('<div class="math math-display">');
    expect(html).toContain(String.raw`L = P_{\text{cpu},L}`);
    expect(html).not.toContain('\\[');
  });

  it('keeps \\(…\\) inside bold', () => {
    const { html } = renderMarkdownWithToc(String.raw`**\(L\)** = floor`);
    expect(html).toContain('<span class="math math-inline">L</span>');
    expect(html).toContain('<strong>');
  });
});

describe('KaTeX post-render (FileViewer effect path)', () => {
  it('renders inline and display placeholders into .katex DOM', async () => {
    const src = [
      'Inline $E=mc^2$ here.',
      '',
      '$$',
      String.raw`\int_0^1 x\,dx`,
      '$$',
      '',
      'Bad: $\\notacommand{}$',
    ].join('\n');
    const { html } = renderMarkdownWithToc(src);

    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.appendChild(root);

    const katex = await getKatex();
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('.math'));
    expect(nodes.length).toBe(3);

    for (const node of nodes) {
      const tex = node.textContent ?? '';
      const displayMode = node.classList.contains('math-display');
      try {
        node.innerHTML = katex.renderToString(tex, {
          displayMode,
          throwOnError: true,
          trust: false,
        });
      } catch {
        node.classList.add('math-error');
      }
    }

    expect(root.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2);
    expect(root.querySelector('.math-inline .katex')).toBeTruthy();
    expect(root.querySelector('.math-display .katex')).toBeTruthy();
    // Invalid TeX keeps source and gains the error class.
    const bad = Array.from(root.querySelectorAll('.math')).find((n) =>
      n.classList.contains('math-error'),
    );
    expect(bad).toBeTruthy();
    expect(bad?.textContent).toContain('notacommand');

    root.remove();
  });
});
