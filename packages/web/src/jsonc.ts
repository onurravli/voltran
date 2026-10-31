import type * as MonacoApi from 'monaco-editor/editor/editor.api.js';

type Monaco = typeof MonacoApi;

// Monaco's basic languages have no JSON (it comes with the JSON language service, which Voltran does
// not load), so JSON, with the comments and trailing commas settings files use, is highlighted here.
export function registerJsonc(monaco: Monaco): void {
    monaco.languages.register({
        id: 'json',
        aliases: ['JSON', 'json'],
        extensions: ['.json', '.jsonc', '.json5', '.code-workspace', '.webmanifest', '.map'],
        filenames: ['.babelrc', '.eslintrc', '.prettierrc', '.swcrc'],
        mimetypes: ['application/json'],
    });
    monaco.languages.setLanguageConfiguration('json', {
        comments: { lineComment: '//', blockComment: ['/*', '*/'] },
        brackets: [
            ['{', '}'],
            ['[', ']'],
        ],
        autoClosingPairs: [
            { open: '{', close: '}', notIn: ['string'] },
            { open: '[', close: ']', notIn: ['string'] },
            { open: '"', close: '"', notIn: ['string', 'comment'] },
        ],
        surroundingPairs: [
            { open: '{', close: '}' },
            { open: '[', close: ']' },
            { open: '"', close: '"' },
        ],
    });
    monaco.languages.setMonarchTokensProvider('json', {
        tokenizer: {
            root: [
                [/\/\/.*$/, 'comment'],
                [/\/\*/, 'comment', '@comment'],
                [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'key'],
                [/"(?:[^"\\]|\\.)*"/, 'string'],
                [/"(?:[^"\\]|\\.)*$/, 'string.invalid'],
                [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
                [/\b(?:true|false|null)\b/, 'keyword'],
                [/[{}[\]]/, '@brackets'],
                [/[,:]/, 'delimiter'],
            ],
            comment: [
                [/[^/*]+/, 'comment'],
                [/\*\//, 'comment', '@pop'],
                [/[/*]/, 'comment'],
            ],
        },
    });
}
