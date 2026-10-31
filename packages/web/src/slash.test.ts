import { describe, expect, it } from 'vitest';
import type { SlashCommand } from '@voltran/shared';
import { commandOf, matchCommands, slashQuery } from './slash.ts';

const command = (name: string, terminal = false): SlashCommand => ({
    name,
    description: '',
    source: 'builtin',
    terminal,
});
const COMMANDS = [
    command('compact'),
    command('config', true),
    command('model', true),
    command('vercel:deploy'),
    command('code-review'),
];

describe('slashQuery', () => {
    it('opens the menu only while a command name is being typed', () => {
        expect(slashQuery('/')).toBe('');
        expect(slashQuery('/Co')).toBe('co');
        expect(slashQuery('/vercel:de')).toBe('vercel:de');
        expect(slashQuery('/compact ')).toBeNull();
        expect(slashQuery('hi /co')).toBeNull();
        expect(slashQuery('')).toBeNull();
    });
});

describe('matchCommands', () => {
    it('puts names that start with the query first, then plugin commands, then the rest', () => {
        expect(matchCommands(COMMANDS, 'co').map((entry) => entry.name)).toEqual(['compact', 'config', 'code-review']);
        expect(matchCommands(COMMANDS, 'dep').map((entry) => entry.name)).toEqual(['vercel:deploy']);
        expect(matchCommands(COMMANDS, 'view').map((entry) => entry.name)).toEqual(['code-review']);
        expect(matchCommands(COMMANDS, '')).toHaveLength(COMMANDS.length);
        expect(matchCommands(COMMANDS, '', 2)).toHaveLength(2);
    });
});

describe('commandOf', () => {
    it('finds the command a message starts with', () => {
        expect(commandOf('/model opus', COMMANDS)?.name).toBe('model');
        expect(commandOf('  /config', COMMANDS)?.terminal).toBe(true);
        expect(commandOf('/models', COMMANDS)).toBeNull();
        expect(commandOf('use /model', COMMANDS)).toBeNull();
    });
});
