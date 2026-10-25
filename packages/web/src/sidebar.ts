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
