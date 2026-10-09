import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { DEFAULT_FONT, cleanFamily, clampFontSize, fontChoices, fontStack, isFontInstalled, type TerminalFont } from '../fonts.ts';
import { filterItems } from '../palette.ts';
import { SHORTCUTS, togglePalette } from '../shortcuts.ts';
import { useUi } from '../store.ts';

interface Item {
    id: string;
    label: string;
    hint?: string;
    keys?: string;
    family?: string;
    keepOpen?: boolean;
    run: () => void;
}

type Mode = 'commands' | 'fonts';

function sameFamily(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
    const font = useUi((state) => state.terminalFont);
    const setTerminalFont = useUi((state) => state.setTerminalFont);
    const [mode, setMode] = useState<Mode>('commands');
    const [families, setFamilies] = useState<string[]>([]);
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const fontBeforePreview = useRef<TerminalFont | null>(null);
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLUListElement>(null);

    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        input.current?.focus();
        return () => {
            if (fontBeforePreview.current) {
                useUi.getState().setTerminalFont(fontBeforePreview.current);
                fontBeforePreview.current = null;
            }
            previous?.focus?.();
        };
    }, []);

    const enterFonts = (): void => {
        const choices = fontChoices(font.family);
        fontBeforePreview.current = font;
        setFamilies(choices);
        setMode('fonts');
        setQuery('');
        setActive(Math.max(0, choices.findIndex((family) => sameFamily(family, font.family))));
    };

    const leaveFonts = (): void => {
        if (fontBeforePreview.current) {
            setTerminalFont(fontBeforePreview.current);
            fontBeforePreview.current = null;
        }
        setMode('commands');
        setQuery('');
        setActive(0);
    };

    const chooseFamily = (family: string): void => {
        fontBeforePreview.current = null;
        setTerminalFont({ ...font, family });
        onClose();
    };

    const resize = (size: number): void => setTerminalFont({ ...font, size: clampFontSize(size) });

    let items: Item[];
    if (mode === 'commands') {
        items = filterItems<Item>([
            { id: 'font-family', label: 'Font family…', hint: font.family, keepOpen: true, run: enterFonts },
            { id: 'font-bigger', label: 'Font size: bigger', hint: `${font.size}px`, keepOpen: true, run: () => resize(font.size + 1) },
            { id: 'font-smaller', label: 'Font size: smaller', hint: `${font.size}px`, keepOpen: true, run: () => resize(font.size - 1) },
            { id: 'font-reset', label: 'Font size: reset', hint: `${DEFAULT_FONT.size}px`, keepOpen: true, run: () => resize(DEFAULT_FONT.size) },
            ...SHORTCUTS
                .filter((shortcut) => shortcut.run !== togglePalette)
                .map((shortcut) => ({ id: shortcut.code, label: shortcut.label, keys: shortcut.keys, run: shortcut.run })),
        ], query);
    } else {
        const current = fontBeforePreview.current?.family ?? font.family;
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
                if (mode === 'fonts') {
                    leaveFonts();
                } else {
                    onClose();
                }
                break;
            case 'Backspace':
                if (mode === 'fonts' && query === '') {
                    event.preventDefault();
                    leaveFonts();
                }
                break;
        }
    };

    return (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
            <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
                {mode === 'fonts' && <div className="palette__crumb">Font family <span>Esc to go back</span></div>}
                <input
                    ref={input}
                    className="palette__input"
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setActive(0);
                    }}
                    onKeyDown={onKeyDown}
                    placeholder={mode === 'fonts' ? 'Pick a font, or type the name of any installed font' : 'Type a command'}
                    spellCheck={false}
                    autoComplete="off"
                    role="combobox"
                    aria-expanded="true"
                    aria-controls="palette-list"
                    aria-activedescendant={items.length ? `palette-item-${selected}` : undefined}
                />
                {items.length === 0 ? (
                    <p className="palette__empty">{mode === 'fonts' ? 'No matching fonts' : 'No matching commands'}</p>
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
