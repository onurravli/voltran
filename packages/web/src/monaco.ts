import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/features/codeEditor/register.js';
import 'monaco-editor/features/codicon/register.js';
import 'monaco-editor/features/diffEditor/register.js';
import 'monaco-editor/features/find/register.js';
import 'monaco-editor/features/clipboard/register.js';
import 'monaco-editor/features/contextmenu/register.js';
import 'monaco-editor/features/bracketMatching/register.js';
import 'monaco-editor/features/caretOperations/register.js';
import 'monaco-editor/features/comment/register.js';
import 'monaco-editor/features/cursorUndo/register.js';
import 'monaco-editor/features/folding/register.js';
import 'monaco-editor/features/gotoLine/register.js';
import 'monaco-editor/features/indentation/register.js';
import 'monaco-editor/features/linesOperations/register.js';
import 'monaco-editor/features/multicursor/register.js';
import 'monaco-editor/features/quickCommand/register.js';
import 'monaco-editor/features/smartSelect/register.js';
import 'monaco-editor/features/suggest/register.js';
import 'monaco-editor/features/wordHighlighter/register.js';
import 'monaco-editor/features/wordOperations/register.js';
import 'monaco-editor/features/wordPartOperations/register.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import { registerJsonc } from './jsonc.ts';

// Only the editor's own worker, which computes diffs and the words it suggests: highlighting comes
// from the basic languages, and no language service runs.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
registerJsonc(monaco);

export { monaco };
