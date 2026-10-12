import { describe, expect, it } from 'vitest';
import { commandPane } from './command.ts';

describe('commandPane', () => {
    it('opens a Claude Code pane for a claude command and keeps its arguments', () => {
        expect(commandPane('claude')).toEqual({ adapter: 'claude' });
        expect(commandPane('claude --plugin-dir ./plugins/x')).toEqual({ adapter: 'claude', command: '--plugin-dir ./plugins/x' });
        expect(commandPane('  claude   --model opus  ')).toEqual({ adapter: 'claude', command: '--model opus' });
    });

    it('runs anything else as a command', () => {
        expect(commandPane('npm run dev')).toEqual({ adapter: 'command', command: 'npm run dev' });
        expect(commandPane('claudex --help')).toEqual({ adapter: 'command', command: 'claudex --help' });
        expect(commandPane('npx claude')).toEqual({ adapter: 'command', command: 'npx claude' });
    });
});
