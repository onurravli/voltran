import type { SlashCommand } from '@voltran/shared';

export const MENU_LIMIT = 50;

// The menu is open while the draft is a command name still being typed: no space or line yet.
export function slashQuery(draft: string): string | null {
    const match = /^\/([\w:.-]*)$/.exec(draft);
    return match ? match[1].toLowerCase() : null;
}

// Names that start with the query come first, then those whose part after a `plugin:` starts with it,
// then any that contain it.
export function matchCommands(commands: SlashCommand[], query: string, limit = MENU_LIMIT): SlashCommand[] {
    const rank = (command: SlashCommand): number => {
        const name = command.name.toLowerCase();
        if (name.startsWith(query)) {
            return 0;
        }
        if (name.split(':').some((part) => part.startsWith(query))) {
            return 1;
        }
        return name.includes(query) ? 2 : -1;
    };
    return commands
        .map((command, index) => ({ command, index, rank: rank(command) }))
        .filter((entry) => entry.rank >= 0)
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .slice(0, limit)
        .map((entry) => entry.command);
}

export function commandOf(text: string, commands: SlashCommand[]): SlashCommand | null {
    const match = /^\/([\w:.-]+)(?:\s|$)/.exec(text.trim());
    return match ? commands.find((command) => command.name === match[1]) ?? null : null;
}
