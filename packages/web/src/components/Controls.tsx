import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { reportError } from '../store.ts';
import { MoreIcon } from './Icons.tsx';

export function InlineEdit({ value, onSave, className, label, editing: requested, onEditingChange }: {
    value: string;
    onSave: (next: string) => Promise<unknown>;
    className: string;
    label: string;
    editing?: boolean;
    onEditingChange?: (editing: boolean) => void;
}) {
    const [own, setOwn] = useState(false);
    const editing = requested ?? own;
    const setEditing = onEditingChange ?? setOwn;
    const [draft, setDraft] = useState(value);

    useEffect(() => {
        if (!editing) {
            setDraft(value);
        }
    }, [value, editing]);

    const commit = (): void => {
        setEditing(false);
        const next = draft.trim();
        if (next && next !== value) {
            onSave(next).catch(reportError);
        }
    };

    const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
        if (event.key === 'Enter') {
            commit();
        } else if (event.key === 'Escape') {
            setEditing(false);
        }
    };

    if (editing) {
        return (
            <input
                className={`${className} inline-edit`}
                aria-label={label}
                value={draft}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={onKeyDown}
            />
        );
    }
    return (
        <span className={className} title="Double-click to rename" onDoubleClick={() => setEditing(true)}>
            {value}
        </span>
    );
}

interface MenuAction {
    label: string;
    note?: string;
    danger?: boolean;
    separated?: boolean;
    onSelect: () => void;
}

interface MenuSwatches {
    label: string;
    swatches: readonly { name: string; value: string }[];
    selected: string;
    separated?: boolean;
    onPick: (value: string) => void;
}

export type MenuItem = MenuAction | MenuSwatches;

const MENU_GAP = 6;
const VIEWPORT_MARGIN = 8;

export function MoreMenu({ label, items, small = false }: { label: string; items: MenuItem[]; small?: boolean }) {
    const [open, setOpen] = useState(false);
    const [place, setPlace] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const menu = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        if (!open || !trigger.current || !menu.current) {
            return;
        }
        const anchor = trigger.current.getBoundingClientRect();
        const { offsetWidth: width, offsetHeight: height } = menu.current;
        const below = anchor.bottom + MENU_GAP + height <= window.innerHeight - VIEWPORT_MARGIN;
        setPlace({
            top: below ? anchor.bottom + MENU_GAP : Math.max(VIEWPORT_MARGIN, anchor.top - MENU_GAP - height),
            left: Math.min(Math.max(VIEWPORT_MARGIN, anchor.right - width), window.innerWidth - width - VIEWPORT_MARGIN),
        });
    }, [open]);

    useEffect(() => {
        if (!open) {
            return;
        }
        const entries = (): HTMLButtonElement[] => [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]') ?? [])];
        const dismiss = (): void => setOpen(false);
        const onPointer = (event: MouseEvent): void => {
            if (!root.current?.contains(event.target as Node)) {
                dismiss();
            }
        };
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                dismiss();
                trigger.current?.focus();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const list = entries();
                const index = list.indexOf(document.activeElement as HTMLButtonElement);
                const step = event.key === 'ArrowDown' ? 1 : -1;
                list[index < 0 ? 0 : (index + step + list.length) % list.length]?.focus();
            }
        };
        const onScroll = (event: Event): void => {
            if (!menu.current?.contains(event.target as Node)) {
                dismiss();
            }
        };
        window.addEventListener('mousedown', onPointer);
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', dismiss);
        window.addEventListener('blur', dismiss);
        entries()[0]?.focus();
        return () => {
            window.removeEventListener('mousedown', onPointer);
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', dismiss);
            window.removeEventListener('blur', dismiss);
        };
    }, [open]);

    return (
        <div className="more" ref={root}>
            <button
                ref={trigger}
                type="button"
                className={`icon-button${small ? '' : ' icon-button--bar'}`}
                aria-label={label}
                title={label}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                <MoreIcon size={small ? 14 : 16} />
            </button>
            {open ? (
                <div className="menu menu--anchored" role="menu" aria-label={label} ref={menu} style={place}>
                    {items.map((item) => ('swatches' in item ? (
                        <div
                            key={item.label}
                            className={`menu__swatches${item.separated ? ' menu__item--separated' : ''}`}
                            role="group"
                            aria-label={item.label}
                        >
                            {item.swatches.map((swatch) => (
                                <button
                                    key={swatch.value}
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={swatch.value.toLowerCase() === item.selected.toLowerCase()}
                                    aria-label={swatch.name}
                                    title={swatch.name}
                                    className="menu__swatch"
                                    style={{ '--swatch': swatch.value } as React.CSSProperties}
                                    onClick={() => item.onPick(swatch.value)}
                                />
                            ))}
                        </div>
                    ) : (
                        <button
                            key={item.label}
                            type="button"
                            role="menuitem"
                            className={`menu__item${item.danger ? ' menu__item--danger' : ''}${item.separated ? ' menu__item--separated' : ''}`}
                            onClick={() => {
                                setOpen(false);
                                item.onSelect();
                            }}
                        >
                            <span>{item.label}</span>
                            {item.note ? <span className="menu__note">{item.note}</span> : null}
                        </button>
                    )))}
                </div>
            ) : null}
        </div>
    );
}
