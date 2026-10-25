import MarkdownIt from 'markdown-it';

// Agent messages quote whatever their tools read, so raw HTML stays text, and images stay text too
// rather than loading from addresses a message names.
const markdown = new MarkdownIt({ html: false, linkify: true });
markdown.disable('image');

const renderLinkOpen = markdown.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noreferrer noopener');
    return renderLinkOpen(tokens, index, options, env, self);
};

export function renderMarkdown(text: string): string {
    return markdown.render(text);
}
