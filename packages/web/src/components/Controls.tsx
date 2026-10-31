import {
    useEffect,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent as ReactMouseEvent,
    type ReactNode,
} from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import type { MenuItem } from '../menus.ts';
import { reportError } from '../store.ts';
import { ChevronIcon, MoreIcon } from './Icons.tsx';

export type { MenuItem } from '../menus.ts';

export function InlineEdit({
    value,
    onSave,
    className,
    label,
    hint = 'Double-click to rename',
    editing: requested,
    onEditingChange,
}: {
    value: string;
    onSave: (next: string) => Promise<unknown>;
    className: string;
    label: string;
    hint?: string;
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
        <span className={className} title={hint} onDoubleClick={() => setEditing(true)}>
            {value}
        </span>
    );
}

const MENU_GAP = 6;
const VIEWPORT_MARGIN = 8;

type MenuItems = MenuItem[] | (() => MenuItem[]);

const resolve = (items: MenuItems): MenuItem[] => (typeof items === 'function' ? items() : items);

// A popup is portalled out of the DOM, but React still bubbles its events through the component that
// rendered it, so a right-click inside a menu would otherwise open the menu of the row around it.
const keepContextMenu = (event: ReactMouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
};

function MenuEntries({ items }: { items: MenuItem[] }) {
    return items.map((item) => {
        const separated = item.separated ? ' menu__item--separated' : '';
        if ('swatches' in item) {
            const selected =
                item.swatches.find((swatch) => swatch.value.toLowerCase() === item.selected.toLowerCase())?.value ??
                null;
            return (
                <Menu.RadioGroup
                    key={item.label}
                    className={`menu__swatches${separated}`}
                    aria-label={item.label}
                    value={selected}
                    onValueChange={(value: string) => item.onPick(value)}
                >
                    {item.swatches.map((swatch) => (
                        <Menu.RadioItem
                            key={swatch.value}
                            value={swatch.value}
                            label={swatch.name}
                            aria-label={swatch.name}
                            title={swatch.name}
                            className="menu__swatch"
                            style={{ '--swatch': swatch.value } as React.CSSProperties}
                        />
                    ))}
                </Menu.RadioGroup>
            );
        }
        if ('items' in item) {
            return (
                <Menu.SubmenuRoot key={item.label} disabled={item.disabled}>
                    <Menu.SubmenuTrigger className={`menu__item${separated}`} disabled={item.disabled}>
                        <span>{item.label}</span>
                        <ChevronIcon size={12} className="menu__chevron" />
                    </Menu.SubmenuTrigger>
                    <Menu.Portal>
                        <Menu.Positioner
                            className="menu-layer"
                            side="inline-end"
                            align="start"
                            sideOffset={4}
                            alignOffset={-5}
                            collisionPadding={VIEWPORT_MARGIN}
                        >
                            <Menu.Popup
                                className="menu menu--floating"
                                aria-label={item.label}
                                onContextMenu={keepContextMenu}
                            >
                                <MenuEntries items={item.items} />
                            </Menu.Popup>
                        </Menu.Positioner>
                    </Menu.Portal>
                </Menu.SubmenuRoot>
            );
        }
        return (
            <Menu.Item
                key={item.label}
                className={`menu__item${item.danger ? ' menu__item--danger' : ''}${separated}`}
                disabled={item.disabled}
                onClick={item.onSelect}
            >
                <span>{item.label}</span>
                {item.note ? <span className="menu__note">{item.note}</span> : null}
            </Menu.Item>
        );
    });
}

function LazyEntries({ items }: { items: MenuItems }) {
    return <MenuEntries items={resolve(items)} />;
}

export function MoreMenu({ label, items, small = false }: { label: string; items: MenuItems; small?: boolean }) {
    return (
        <Menu.Root>
            <Menu.Trigger className={`icon-button${small ? '' : ' icon-button--bar'}`} aria-label={label} title={label}>
                <MoreIcon size={small ? 14 : 16} />
            </Menu.Trigger>
            <Menu.Portal>
                <Menu.Positioner
                    className="menu-layer"
                    side="bottom"
                    align="end"
                    sideOffset={MENU_GAP}
                    collisionPadding={VIEWPORT_MARGIN}
                >
                    <Menu.Popup className="menu menu--floating" aria-label={label} onContextMenu={keepContextMenu}>
                        <LazyEntries items={items} />
                    </Menu.Popup>
                </Menu.Positioner>
            </Menu.Portal>
        </Menu.Root>
    );
}

// macOS has no key that opens a context menu, and a browser opens one from the keyboard only on some
// systems, so the ContextMenu key and Shift+F10 open it below the focused row everywhere.
function openFromKeyboard(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    const row = event.target as HTMLElement;
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(
        new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + 12,
            clientY: rect.bottom,
        }),
    );
}

// The trigger is display: contents, so wrapping a row changes nothing about its layout. Items are
// built when the menu opens, from the state at that moment.
export function ContextMenuArea({
    label,
    items,
    render,
    children,
}: {
    label: string;
    items: () => MenuItem[];
    render?: ContextMenu.Trigger.Props['render'];
    children: ReactNode;
}) {
    return (
        <ContextMenu.Root>
            <ContextMenu.Trigger
                className={render ? undefined : 'context-area'}
                render={render}
                onKeyDown={openFromKeyboard}
            >
                {children}
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
                <ContextMenu.Positioner className="menu-layer" collisionPadding={VIEWPORT_MARGIN}>
                    <ContextMenu.Popup
                        className="menu menu--floating"
                        aria-label={label}
                        onContextMenu={keepContextMenu}
                    >
                        <LazyEntries items={items} />
                    </ContextMenu.Popup>
                </ContextMenu.Positioner>
            </ContextMenu.Portal>
        </ContextMenu.Root>
    );
}
