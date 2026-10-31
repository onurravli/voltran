import { describe, expect, it } from 'vitest';
import { commandPane } from './command.ts';

describe('commandPane', () => {
    it('opens a Claude Code pane for a claude command and keeps its arguments', () => {
        expect(commandPane('claude')).toEqual({ adapter: 'claude' });
        expect(commandPane('claude --plugin-dir ./plugins/x')).toEqual({
            adapter: 'claude',
            command: '--plugin-dir ./plugins/x',
        });
        expect(commandPane('  claude   --model opus  ')).toEqual({ adapter: 'claude', command: '--model opus' });
    });

    it('opens an OpenCode pane for an opencode command and keeps its arguments', () => {
        expect(commandPane('opencode')).toEqual({ adapter: 'opencode' });
        expect(commandPane('  opencode   --model anthropic/claude-sonnet-4-5  ')).toEqual({
            adapter: 'opencode',
            command: '--model anthropic/claude-sonnet-4-5',
        });
    });

    it('opens a preview pane for a page on this computer', () => {
        expect(commandPane('localhost:5173')).toEqual({ adapter: 'preview', command: 'http://localhost:5173/' });
        expect(commandPane(' https://127.0.0.1:8443/app ')).toEqual({
            adapter: 'preview',
            command: 'https://127.0.0.1:8443/app',
        });
        expect(commandPane('curl localhost:5173')).toEqual({ adapter: 'command', command: 'curl localhost:5173' });
    });

    it('runs anything else as a command', () => {
        expect(commandPane('npm run dev')).toEqual({ adapter: 'command', command: 'npm run dev' });
        expect(commandPane('claudex --help')).toEqual({ adapter: 'command', command: 'claudex --help' });
        expect(commandPane('npx claude')).toEqual({ adapter: 'command', command: 'npx claude' });
        expect(commandPane('opencodex')).toEqual({ adapter: 'command', command: 'opencodex' });
    });
});
