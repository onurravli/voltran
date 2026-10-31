import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.ts';

describe('renderMarkdown', () => {
    it('renders the markdown agents write', () => {
        expect(renderMarkdown('## Plan\n\n- **one** `two`\n\n```ts\nconst a = 1;\n```')).toBe(
            '<h2>Plan</h2>\n<ul>\n<li><strong>one</strong> <code>two</code></li>\n</ul>\n<pre><code class="language-ts"><span class="hljs-keyword">const</span> a = <span class="hljs-number">1</span>;\n</code></pre>\n',
        );
    });

    it('highlights a block that names a language it knows, and only that', () => {
        expect(renderMarkdown('```sh\necho "<b>"\n```')).toBe(
            '<pre><code class="language-sh"><span class="hljs-built_in">echo</span> <span class="hljs-string">&quot;&lt;b&gt;&quot;</span>\n</code></pre>\n',
        );
        expect(renderMarkdown('```\nconst a = 1;\n```')).toBe('<pre><code>const a = 1;\n</code></pre>\n');
        expect(renderMarkdown('```brainfuck\n<b>\n```')).toBe(
            '<pre><code class="language-brainfuck">&lt;b&gt;\n</code></pre>\n',
        );
    });

    it('keeps raw HTML and images as text', () => {
        const html = renderMarkdown(
            '<img src=x onerror=alert(1)> <script>alert(1)</script>\n\n![pixel](https://tracker.example/p.png)',
        );
        expect(html).not.toMatch(/<img|<script/);
        expect(html).toContain('&lt;script&gt;');
    });

    it('opens links in a new tab and refuses script addresses', () => {
        expect(renderMarkdown('[docs](https://example.com)')).toBe(
            '<p><a href="https://example.com" target="_blank" rel="noreferrer noopener">docs</a></p>\n',
        );
        expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('<a');
    });
});
