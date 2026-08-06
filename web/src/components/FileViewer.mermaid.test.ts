import { describe, it, expect } from 'vitest';
import { renderMarkdownWithToc } from './FileViewer';

describe('renderMarkdownWithToc mermaid fences', () => {
  it('turns ```mermaid into <pre class="mermaid"> with escaped source', () => {
    const src = [
      '# Title',
      '',
      '```mermaid',
      'flowchart TD',
      '  A["x < y"] --> B',
      '```',
      '',
      'after',
    ].join('\n');

    const { html, headings } = renderMarkdownWithToc(src);

    expect(headings.map((h) => h.text)).toEqual(['Title']);
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain('flowchart TD');
    // Source must be HTML-escaped so a label with `<` does not break the DOM
    // before mermaid.run reads textContent (entities decode there).
    expect(html).toContain('A[&quot;x &lt; y&quot;] --&gt; B');
    expect(html).not.toContain('A["x < y"]');
    // Must not fall through to a plain language-mermaid code block.
    expect(html).not.toContain('language-mermaid');
  });

  it('leaves non-mermaid fences as ordinary code blocks', () => {
    const src = ['```ts', 'const x = 1;', '```'].join('\n');
    const { html } = renderMarkdownWithToc(src);
    expect(html).toContain('language-ts');
    expect(html).not.toContain('class="mermaid"');
  });

  it('matches language case-insensitively and ignores trailing fence info', () => {
    const src = ['```Mermaid theme=dark', 'sequenceDiagram', '  A->>B: hi', '```'].join(
      '\n',
    );
    const { html } = renderMarkdownWithToc(src);
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain('sequenceDiagram');
  });
});
