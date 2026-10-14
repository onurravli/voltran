import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { PaneStatus } from '@voltran/shared';
import { DEFAULT_FONT, cleanFamily, clampFontSize, fontChoices, fontStack, isFontInstalled, type TerminalFont } from '../fonts.ts';
import { installApp } from '../install.ts';
import { revealPane } from '../notify.ts';
import { destinations, filterItems } from '../palette.ts';
import { FIND_SHORTCUT, SHORTCUTS, editSettings, openSettingsInApp, togglePalette, visibleFocusedPane } from '../shortcuts.ts';
import { useUi } from '../store.ts';
import { APPEARANCES, THEMES, schemeOf, themeById, type Appearance, type Scheme, type Theme } from '../themes.ts';
import { StatusLamp } from './StatusLamp.tsx';

interface Item {
    id: string;
    label: string;
    keywords?: string;
    status?: PaneStatus | null;
    hint?: string;
    keys?: string;
    family?: string;
    themeId?: string;
    keepOpen?: boolean;
    run: () => void;
}

type Mode = 'commands' | 'fonts' | 'appearance' | Scheme;

const COPY: Record<Mode, { title?: string; placeholder: string; empty: string }> = {
    commands: { placeholder: 'Type a command, or a session or pane name', empty: 'No matching commands, sessions or panes' },
    fonts: { title: 'Font family', placeholder: 'Pick a font, or type the name of any installed font', empty: 'No matching fonts' },
    appearance: { title: 'Appearance', placeholder: 'Follow the system, or always use dark or light', empty: 'No matching appearance' },
    dark: { title: 'Dark theme', placeholder: 'Pick the theme for dark appearance', empty: 'No matching themes' },
    light: { title: 'Light theme', placeholder: 'Pick the theme for light appearance', empty: 'No matching themes' },
};

const APPEARANCE_LABELS: Record<Appearance, string> = { system: 'System', dark: 'Dark', light: 'Light' };

function themesOf(scheme: Scheme): Theme[] {
    return THEMES.filter((theme) => theme.scheme === scheme);
}

function sameFamily(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
}

function restore(font: TerminalFont | null): void {
    const state = useUi.getState();
    if (state.previewThemeId) {
        state.setPreviewTheme(null);
    }
    if (font && state.terminalFont !== font) {
        state.setTerminalFont(font);
    }
}

function ThemeSwatch({ theme }: { theme: Theme }) {
    const { background, red, yellow, green, blue, magenta } = theme.terminal;
    return (
        <span className="palette__swatch" style={{ background }} aria-hidden="true">
            {[red, yellow, green, blue, magenta].map((color, index) => <i key={index} style={{ background: color }} />)}
        </span>
    );
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
    const font = useUi((state) => state.terminalFont);
    const appearance = useUi((state) => state.appearance);
    const setAppearance = useUi((state) => state.setAppearance);
    const themeIds = useUi((state) => state.themeIds);
    const setTheme = useUi((state) => state.setTheme);
    const saveSettings = useUi((state) => state.saveSettings);
    const sidebarPosition = useUi((state) => state.sidebarPosition);
    const systemScheme = useUi((state) => state.systemScheme);
    const app = useUi((state) => state.app);
    const installable = useUi((state) => state.installable);
    const [mode, setMode] = useState<Mode>('commands');
    const [families, setFamilies] = useState<string[]>([]);
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const committedFont = useRef<TerminalFont | null>(null);
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLUListElement>(null);

    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        input.current?.focus();
        return () => {
            restore(committedFont.current);
            committedFont.current = null;
            previous?.focus?.();
        };
    }, []);

    const enterList = (next: Exclude<Mode, 'commands'>, index: number): void => {
        committedFont.current = font;
        setMode(next);
        setQuery('');
        setActive(Math.max(0, index));
    };

    const enterFonts = (): void => {
        const choices = fontChoices(font.family);
        setFamilies(choices);
        enterList('fonts', choices.findIndex((family) => sameFamily(family, font.family)));
    };

    const enterAppearance = (): void => enterList('appearance', APPEARANCES.indexOf(appearance));

    const enterThemes = (scheme: Scheme): void => enterList(scheme, themesOf(scheme).findIndex((theme) => theme.id === themeIds[scheme]));

    const leaveList = (): void => {
        restore(committedFont.current);
        committedFont.current = null;
        setMode('commands');
        setQuery('');
        setActive(0);
    };

    const chooseFamily = (family: string): void => {
        committedFont.current = null;
        saveSettings({ terminal: { fontFamily: family } });
        onClose();
    };

    const chooseAppearance = (next: Appearance): void => {
        committedFont.current = null;
        setAppearance(next);
        onClose();
    };

    const chooseTheme = (id: string): void => {
        committedFont.current = null;
        setTheme(id);
        onClose();
    };

    const appearanceLabel = (option: Appearance): string => (option === 'system' ? `System (${systemScheme})` : APPEARANCE_LABELS[option]);

    const resize = (size: number): void => saveSettings({ terminal: { fontSize: clampFontSize(size) } });
    const otherSide = sidebarPosition === 'left' ? 'right' : 'left';

    let items: Item[];
    if (mode === 'commands') {
        const places: Item[] = query.trim() ? destinations(app).map((place) => ({
            id: place.id,
            label: place.label,
            keywords: place.keywords,
            status: place.status,
            hint: place.keywords,
            run: () => (place.paneId ? revealPane(place.sessionId, place.paneId) : useUi.getState().selectSession(place.sessionId)),
        })) : [];
        const findIn = visibleFocusedPane();
        items = filterItems<Item>([
            ...places,
            ...(findIn ? [{ id: 'find', ...FIND_SHORTCUT, run: () => useUi.getState().openFind(findIn) }] : []),
            { id: 'appearance', label: 'Appearance…', keywords: 'system dark light mode', hint: appearanceLabel(appearance), keepOpen: true, run: enterAppearance },
            { id: 'theme-dark', label: 'Dark theme…', hint: themeById(themeIds.dark).name, keepOpen: true, run: () => enterThemes('dark') },
            { id: 'theme-light', label: 'Light theme…', hint: themeById(themeIds.light).name, keepOpen: true, run: () => enterThemes('light') },
            { id: 'font-family', label: 'Font family…', hint: font.family, keepOpen: true, run: enterFonts },
            { id: 'font-bigger', label: 'Font size: bigger', hint: `${font.size}px`, keepOpen: true, run: () => resize(font.size + 1) },
            { id: 'font-smaller', label: 'Font size: smaller', hint: `${font.size}px`, keepOpen: true, run: () => resize(font.size - 1) },
            { id: 'font-reset', label: 'Font size: reset', hint: `${DEFAULT_FONT.size}px`, keepOpen: true, run: () => resize(DEFAULT_FONT.size) },
            { id: 'sidebar-side', label: `Move the sidebar to the ${otherSide}`, keywords: 'sidebar position left right', run: () => saveSettings({ sidebar: { position: otherSide } }) },
            { id: 'settings-file', label: 'Open the settings file', keywords: 'settings.json preferences configuration editor vim', run: editSettings },
            { id: 'settings-file-app', label: 'Open the settings file in the default app', keywords: 'settings.json preferences configuration editor', run: openSettingsInApp },
            ...(installable ? [{ id: 'install-app', label: 'Install Voltran as an app', keywords: 'dock window desktop pwa', run: installApp }] : []),
            ...SHORTCUTS
                .filter((shortcut) => shortcut.run !== togglePalette)
                .map((shortcut) => ({ id: shortcut.code, label: shortcut.label, keys: shortcut.keys, run: shortcut.run })),
        ], query);
    } else if (mode === 'appearance') {
        items = filterItems<Item>(APPEARANCES.map((option) => ({
            id: `appearance:${option}`,
            label: appearanceLabel(option),
            keywords: option === 'system' ? 'auto' : undefined,
            themeId: themeIds[schemeOf(option, systemScheme)],
            hint: option === appearance ? 'current' : undefined,
            run: () => chooseAppearance(option),
        })), query);
    } else if (mode === 'dark' || mode === 'light') {
        items = filterItems<Item>(themesOf(mode).map((theme) => ({
            id: `theme:${theme.id}`,
            label: theme.name,
            themeId: theme.id,
            hint: theme.id === themeIds[mode] ? 'current' : undefined,
            run: () => chooseTheme(theme.id),
        })), query);
    } else {
        const current = committedFont.current?.family ?? font.family;
        items = filterItems<Item>(families.map((family) => ({
            id: `family:${family}`,
            label: family,
            family,
            hint: !sameFamily(family, current) ? undefined : isFontInstalled(family) ? 'current' : 'current, not installed',
            run: () => chooseFamily(family),
        })), query);
        const custom = cleanFamily(query);
        if (custom && !families.some((family) => sameFamily(family, custom))) {
            items.push({
                id: 'family:custom',
                label: `Use “${custom}”`,
                hint: isFontInstalled(custom) ? undefined : 'not installed',
                run: () => chooseFamily(custom),
            });
        }
    }

    const selected = Math.min(active, Math.max(0, items.length - 1));
    const preview = mode === 'fonts' ? items[selected]?.family : undefined;
    const previewTheme = mode !== 'commands' ? items[selected]?.themeId : undefined;

    useEffect(() => {
        if (!preview) {
            return;
        }
        const current = useUi.getState().terminalFont;
        if (current.family !== preview) {
            useUi.getState().setTerminalFont({ ...current, family: preview });
        }
    }, [preview]);

    useEffect(() => {
        if (previewTheme) {
            useUi.getState().setPreviewTheme(previewTheme);
        }
    }, [previewTheme]);

    useEffect(() => {
        list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }, [selected, mode]);

    const run = (item: Item | undefined): void => {
        if (!item) {
            return;
        }
        if (!item.keepOpen) {
            onClose();
        }
        item.run();
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        const count = items.length;
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                setActive(count ? (selected + 1) % count : 0);
                break;
            case 'ArrowUp':
                event.preventDefault();
                setActive(count ? (selected - 1 + count) % count : 0);
                break;
            case 'Enter':
                event.preventDefault();
                run(items[selected]);
                break;
            case 'Escape':
                event.preventDefault();
                event.stopPropagation();
                if (mode !== 'commands') {
                    leaveList();
                } else {
                    onClose();
                }
                break;
            case 'Backspace':
                if (mode !== 'commands' && query === '') {
                    event.preventDefault();
                    leaveList();
                }
                break;
        }
    };

    return (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
            <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
                {COPY[mode].title && <div className="palette__crumb">{COPY[mode].title} <span>Esc to go back</span></div>}
                <input
                    ref={input}
                    className="palette__input"
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setActive(0);
                    }}
                    onKeyDown={onKeyDown}
                    placeholder={COPY[mode].placeholder}
                    spellCheck={false}
                    autoComplete="off"
                    role="combobox"
                    aria-expanded="true"
                    aria-controls="palette-list"
                    aria-activedescendant={items.length ? `palette-item-${selected}` : undefined}
                />
                {items.length === 0 ? (
                    <p className="palette__empty">{COPY[mode].empty}</p>
                ) : (
                    <ul className="palette__list" id="palette-list" role="listbox" ref={list}>
                        {items.map((item, index) => (
                            <li
                                key={item.id}
                                id={`palette-item-${index}`}
                                role="option"
                                aria-selected={index === selected}
                                className={`palette__item${index === selected ? ' palette__item--active' : ''}`}
                                onMouseMove={() => index !== selected && setActive(index)}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => run(item)}
                            >
                                {item.themeId && <ThemeSwatch theme={themeById(item.themeId)} />}
                                {item.status !== undefined && <StatusLamp status={item.status} size="sm" />}
                                <span className="palette__label" style={item.family ? { fontFamily: fontStack(item.family) } : undefined}>{item.label}</span>
                                {item.keys ? <kbd>{item.keys}</kbd> : item.hint && <span className="palette__hint">{item.hint}</span>}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
