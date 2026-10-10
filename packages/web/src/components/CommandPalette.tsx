import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { PaneStatus } from '@voltran/shared';
import { DEFAULT_FONT, cleanFamily, clampFontSize, fontChoices, fontStack, isFontInstalled, type TerminalFont } from '../fonts.ts';
import { revealPane } from '../notify.ts';
import { destinations, filterItems } from '../palette.ts';
import { SHORTCUTS, togglePalette } from '../shortcuts.ts';
import { useUi } from '../store.ts';
import { THEMES, themeById, type Theme } from '../themes.ts';
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

type Mode = 'commands' | 'fonts' | 'themes';

const COPY: Record<Mode, { title?: string; placeholder: string; empty: string }> = {
    commands: { placeholder: 'Type a command, or a session or pane name', empty: 'No matching commands, sessions or panes' },
    fonts: { title: 'Font family', placeholder: 'Pick a font, or type the name of any installed font', empty: 'No matching fonts' },
    themes: { title: 'Theme', placeholder: 'Pick a theme', empty: 'No matching themes' },
};

interface Committed {
    font: TerminalFont;
    themeId: string;
}

function sameFamily(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
}

function restore(committed: Committed | null): void {
    if (!committed) {
        return;
    }
    const state = useUi.getState();
    if (state.terminalFont !== committed.font) {
        state.setTerminalFont(committed.font);
    }
    if (state.themeId !== committed.themeId) {
        state.setTheme(committed.themeId);
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
    const setTerminalFont = useUi((state) => state.setTerminalFont);
    const themeId = useUi((state) => state.themeId);
    const setTheme = useUi((state) => state.setTheme);
    const app = useUi((state) => state.app);
    const [mode, setMode] = useState<Mode>('commands');
    const [families, setFamilies] = useState<string[]>([]);
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const committed = useRef<Committed | null>(null);
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLUListElement>(null);

    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        input.current?.focus();
        return () => {
            restore(committed.current);
            committed.current = null;
            previous?.focus?.();
        };
    }, []);

    const enterList = (next: Exclude<Mode, 'commands'>, index: number): void => {
        committed.current = { font, themeId };
        setMode(next);
        setQuery('');
        setActive(Math.max(0, index));
    };

    const enterFonts = (): void => {
        const choices = fontChoices(font.family);
        setFamilies(choices);
        enterList('fonts', choices.findIndex((family) => sameFamily(family, font.family)));
    };

    const enterThemes = (): void => enterList('themes', THEMES.findIndex((theme) => theme.id === themeId));

    const leaveList = (): void => {
        restore(committed.current);
        committed.current = null;
        setMode('commands');
        setQuery('');
        setActive(0);
    };

    const chooseFamily = (family: string): void => {
        committed.current = null;
        setTerminalFont({ ...font, family });
        onClose();
    };

    const chooseTheme = (id: string): void => {
        committed.current = null;
        setTheme(id);
        onClose();
    };

    const resize = (size: number): void => setTerminalFont({ ...font, size: clampFontSize(size) });

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
        items = filterItems<Item>([
            ...places,
            { id: 'theme', label: 'Theme…', hint: themeById(themeId).name, keepOpen: true, run: enterThemes },
            { id: 'font-family', label: 'Font family…', hint: font.family, keepOpen: true, run: enterFonts },
            { id: 'font-bigger', label: 'Font size: bigger', hint: `${font.size}px`, keepOpen: true, run: () => resize(font.size + 1) },
            { id: 'font-smaller', label: 'Font size: smaller', hint: `${font.size}px`, keepOpen: true, run: () => resize(font.size - 1) },
            { id: 'font-reset', label: 'Font size: reset', hint: `${DEFAULT_FONT.size}px`, keepOpen: true, run: () => resize(DEFAULT_FONT.size) },
            ...SHORTCUTS
                .filter((shortcut) => shortcut.run !== togglePalette)
                .map((shortcut) => ({ id: shortcut.code, label: shortcut.label, keys: shortcut.keys, run: shortcut.run })),
        ], query);
    } else if (mode === 'themes') {
        const current = committed.current?.themeId ?? themeId;
        items = filterItems<Item>(THEMES.map((theme) => ({
            id: `theme:${theme.id}`,
            label: theme.name,
            themeId: theme.id,
            hint: theme.id === current ? 'current' : undefined,
            run: () => chooseTheme(theme.id),
        })), query);
    } else {
        const current = committed.current?.font.family ?? font.family;
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
    const previewTheme = mode === 'themes' ? items[selected]?.themeId : undefined;

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
            useUi.getState().setTheme(previewTheme);
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
