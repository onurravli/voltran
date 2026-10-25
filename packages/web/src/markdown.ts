import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import makefile from 'highlight.js/lib/languages/makefile';
import markdownLanguage from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import MarkdownIt from 'markdown-it';

const LANGUAGES = {
    bash,
    c,
    cpp,
    css,
    diff,
    dockerfile,
    go,
    ini,
    java,
    javascript,
    json,
    makefile,
    markdown: markdownLanguage,
    python,
    ruby,
    rust,
    shell,
    sql,
    swift,
    typescript,
    xml,
    yaml,
};
for (const [name, language] of Object.entries(LANGUAGES)) {
    hljs.registerLanguage(name, language);
}

// Only a block that names its language is highlighted: guessing gets short snippets wrong.
function highlight(code: string, language: string): string {
    if (!language || !hljs.getLanguage(language)) {
        return '';
    }
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}

// Agent messages quote whatever their tools read, so raw HTML stays text, and images stay text too
// rather than loading from addresses a message names.
const markdown = new MarkdownIt({ html: false, linkify: true, highlight });
markdown.disable('image');

const renderLinkOpen =
    markdown.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noreferrer noopener');
    return renderLinkOpen(tokens, index, options, env, self);
};

export function renderMarkdown(text: string): string {
    return markdown.render(text);
}
