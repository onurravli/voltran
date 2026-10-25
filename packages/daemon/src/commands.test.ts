import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCommands, frontmatter } from './commands.ts';

const cleanups: (() => void)[] = [];

afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
});

function write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}

describe('frontmatter', () => {
    it('reads the name and description, folded blocks and frontmatter longer than what is read', () => {
        expect(frontmatter('---\nname: deploy\ndescription: "Ship it"\n---\nbody')).toEqual({ name: 'deploy', description: 'Ship it' });
        expect(frontmatter('---\ndescription: >-\n  One\n  two\n---\n').description).toBe('One two');
        expect(frontmatter('# Review the diff\n\nMore text').description).toBe('Review the diff');
        expect(frontmatter(`---\ndescription: Long\nmetadata:\n${'  x: y\n'.repeat(5000)}`).description).toBe('Long');
    });
});

describe('claudeCommands', () => {
    it('lists project, user and enabled plugin commands and skills before the built-in ones, as Claude names them', () => {
        const home = mkdtempSync(join(tmpdir(), 'voltran-commands-'));
        cleanups.push(() => rmSync(home, { recursive: true, force: true }));
        const config = join(home, '.claude');
        const project = join(home, 'code', 'app');
        write(join(project, '.claude', 'commands', 'frontend', 'component.md'), '---\ndescription: Make a component\n---\n');
        write(join(home, 'code', '.claude', 'commands', 'parent.md'), 'From the parent folder\n');
        write(join(config, 'commands', 'mine.md'), '---\ndescription: Mine\n---\n');
        write(join(config, 'commands', '_conventions.md'), 'shared text\n');
        write(join(config, 'skills', 'notes', 'SKILL.md'), '---\nname: notes\ndescription: Take notes\n---\n');
        write(join(config, 'skills', 'notes', 'upstream', 'SKILL.md'), '---\nname: nested\n---\n');
        write(join(config, 'skills', 'synced', 'abc', 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: PDFs\n---\n');
        write(join(config, 'skills', 'synced', 'abc', 'deep-research', 'SKILL.md'), '---\nname: deep-research\ndescription: Synced\n---\n');
        const plugin = join(config, 'plugins', 'cache', 'market', 'tools', '1.0.0');
        const off = join(config, 'plugins', 'cache', 'market', 'off', '1.0.0');
        write(join(plugin, 'commands', 'deploy.md'), '---\ndescription: Deploy\n---\n');
        write(join(plugin, 'skills', 'lint', 'SKILL.md'), '---\nname: lint\ndescription: Lint\n---\n');
        write(join(off, 'commands', 'hidden.md'), 'Hidden\n');
        write(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: {
                'tools@market': [{ scope: 'user', installPath: plugin }],
                'off@market': [{ scope: 'user', installPath: off }],
            },
        }));
        write(join(config, 'settings.json'), JSON.stringify({ enabledPlugins: { 'tools@market': true, 'off@market': true } }));
        write(join(project, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'off@market': false } }));

        const commands = claudeCommands(project, config, home);
        const custom = commands.filter((command) => command.source !== 'builtin').map(({ name, source, description }) => `${source} /${name} ${description}`);
        expect(custom).toEqual([
            'project /frontend:component Make a component',
            'project /parent From the parent folder',
            'user /mine Mine',
            'user /notes Take notes',
            'user /anthropic-skills:deep-research Synced',
            'user /pdf PDFs',
            'plugin /tools:deploy Deploy',
            'plugin /tools:lint Lint',
        ]);
        expect(commands.find((command) => command.name === 'model')).toMatchObject({ source: 'builtin', terminal: true });
        expect(commands.find((command) => command.name === 'compact')).toMatchObject({ source: 'builtin', terminal: false });
        expect(commands.filter((command) => command.name === 'deep-research')).toHaveLength(1);
    });
});
