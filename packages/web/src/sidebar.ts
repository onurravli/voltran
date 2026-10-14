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
