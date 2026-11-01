export const DEFAULT_SIDEBAR_WIDTH = 272;
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 480;
export const SIDEBAR_WIDTH_STEP = 16;
export const COLLAPSE_SIDEBAR_BELOW = 100;

export function clampSidebarWidth(width: unknown): number {
    if (typeof width !== 'number' || !Number.isFinite(width)) {
        return DEFAULT_SIDEBAR_WIDTH;
    }
    return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

// Dragged past the minimum, the sidebar stays at it until the pointer is well to the left, then closes.
export function draggedSidebarWidth(width: number): number | null {
    return width < COLLAPSE_SIDEBAR_BELOW ? null : clampSidebarWidth(width);
}

export type DropSide = 'before' | 'after';

export function dropSide(offset: number, height: number): DropSide {
    return offset < height / 2 ? 'before' : 'after';
}

// What to move an item in front of (null: to the end) so that it lands on that side of the target.
export function dropBefore(ids: readonly string[], target: string, side: DropSide): string | null {
    return side === 'before' ? target : (ids[ids.indexOf(target) + 1] ?? null);
}

// Undefined when the item is already at that end of the list.
export function stepBefore(ids: readonly string[], id: string, step: -1 | 1): string | null | undefined {
    const index = ids.indexOf(id);
    const to = index + step;
    if (index === -1 || to < 0 || to >= ids.length) {
        return undefined;
    }
    return step === -1 ? ids[to] : (ids[to + 1] ?? null);
}

// Rows picked together within one scope (a project), kept in the order of that scope's rows. A Shift
// range replaces the previous range from the same anchor but keeps the rows ⌘-clicked before it (`kept`).
export interface RowSelection {
    scope: string;
    ids: string[];
    anchor: string;
    kept: string[];
}

export type SelectionMode = 'toggle' | 'range';

// ⌘-click toggles a row on a Mac, where Control-click is a right-click; elsewhere Ctrl-click does.
export function selectionMode(
    event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
    mac: boolean,
): SelectionMode | null {
    if (event.altKey) {
        return null;
    }
    if (event.shiftKey && !event.metaKey && !event.ctrlKey) {
        return 'range';
    }
    const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    return primary && !event.shiftKey ? 'toggle' : null;
}

// A selection starts with the clicked row alone, so the open row is never picked without being
// clicked; only a Shift range with nothing picked yet starts at the open row.
export function extendSelection(
    current: RowSelection | null,
    scope: string,
    rows: readonly string[],
    id: string,
    mode: SelectionMode,
    open: string | null,
): RowSelection | null {
    if (!rows.includes(id)) {
        return current;
    }
    const inRows = (ids: readonly string[]) => rows.filter((row) => ids.includes(row));
    const start: RowSelection =
        current?.scope === scope
            ? { ...current, ids: inRows(current.ids), kept: inRows(current.kept) }
            : {
                  scope,
                  ids: [],
                  anchor: mode === 'range' && open !== null && rows.includes(open) ? open : id,
                  kept: [],
              };
    if (mode === 'toggle') {
        const ids = inRows(start.ids.includes(id) ? start.ids.filter((row) => row !== id) : [...start.ids, id]);
        return ids.length === 0 ? null : { scope, ids, anchor: id, kept: ids };
    }
    const anchor = rows.includes(start.anchor) ? start.anchor : id;
    const [from, to] = [rows.indexOf(anchor), rows.indexOf(id)].sort((a, b) => a - b);
    const range = rows.slice(from, to + 1);
    return { scope, ids: inRows([...start.kept, ...range]), anchor, kept: start.kept };
}
