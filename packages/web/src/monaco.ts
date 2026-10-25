import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/features/codeEditor/register.js';
import 'monaco-editor/features/codicon/register.js';
import 'monaco-editor/features/diffEditor/register.js';
import 'monaco-editor/features/find/register.js';
import 'monaco-editor/features/clipboard/register.js';
import 'monaco-editor/features/contextmenu/register.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

// Only the editor's own worker, which computes diffs: highlighting comes from the basic languages,
// and no language service runs.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export { monaco };
