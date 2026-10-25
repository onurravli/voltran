import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.ts';

describe('renderMarkdown', () => {
    it('renders the markdown agents write', () => {
        expect(renderMarkdown('## Plan\n\n- **one** `two`\n\n```ts\nconst a = 1;\n```')).toBe(
            '<h2>Plan</h2>\n<ul>\n<li><strong>one</strong> <code>two</code></li>\n</ul>\n<pre><code class="language-ts">const a = 1;\n</code></pre>\n',
        );
    });

    it('keeps raw HTML and images as text', () => {
        const html = renderMarkdown('<img src=x onerror=alert(1)> <script>alert(1)</script>\n\n![pixel](https://tracker.example/p.png)');
        expect(html).not.toMatch(/<img|<script/);
        expect(html).toContain('&lt;script&gt;');
    });

    it('opens links in a new tab and refuses script addresses', () => {
        expect(renderMarkdown('[docs](https://example.com)')).toBe('<p><a href="https://example.com" target="_blank" rel="noreferrer noopener">docs</a></p>\n');
        expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('<a');
    });
});
