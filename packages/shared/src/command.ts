import type { PaneSpec } from './types.ts';

export function commandPane(command: string): PaneSpec {
    const agent = /^\s*(claude|opencode)(?:\s+([\s\S]*))?$/.exec(command);
    if (!agent) {
        return { adapter: 'command', command: command.trim() };
    }
    const adapter = agent[1] === 'claude' ? 'claude' : 'opencode';
    const args = agent[2]?.trim();
    return args ? { adapter, command: args } : { adapter };
}
