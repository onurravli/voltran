import type { PaneSpec } from './types.ts';

export function commandPane(command: string): PaneSpec {
    const claude = /^\s*claude(?:\s+([\s\S]*))?$/.exec(command);
    if (!claude) {
        return { adapter: 'command', command: command.trim() };
    }
    const args = claude[1]?.trim();
    return args ? { adapter: 'claude', command: args } : { adapter: 'claude' };
}
