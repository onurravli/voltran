import { previewUrl } from './preview.ts';
import type { PaneSpec } from './types.ts';

export function commandPane(command: string): PaneSpec {
    const url = previewUrl(command);
    if (url) {
        return { adapter: 'preview', command: url };
    }
    const agent = /^\s*(claude|opencode)(?:\s+([\s\S]*))?$/.exec(command);
    if (!agent) {
        return { adapter: 'command', command: command.trim() };
    }
    const adapter = agent[1] === 'claude' ? 'claude' : 'opencode';
    const args = agent[2]?.trim();
    return args ? { adapter, command: args } : { adapter };
}
