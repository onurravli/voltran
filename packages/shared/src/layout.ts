import type { Layout, LayoutDirection, LayoutSplit } from './types.ts';

export const MAX_WORKSPACE_PANES = 16;

const leaf = (paneId: string): Layout => ({ type: 'pane', paneId });

const evenSizes = (count: number): number[] => Array.from({ length: count }, () => 100 / count);

export function paneIds(layout: Layout | null): string[] {
    if (!layout) {
        return [];
    }
    if (layout.type === 'pane') {
        return [layout.paneId];
    }
    return layout.children.flatMap(paneIds);
}

export function insertPane(layout: Layout | null, paneId: string, targetId?: string, direction: LayoutDirection = 'horizontal'): Layout {
    if (!layout) {
        return leaf(paneId);
    }
    if (targetId && paneIds(layout).includes(targetId)) {
        return insertNextTo(layout, leaf(paneId), targetId, direction);
    }
    return append(layout, leaf(paneId), direction);
}

function append(layout: Layout, inserted: Layout, direction: LayoutDirection): Layout {
    if (layout.type === 'split' && layout.direction === direction) {
        const children = [...layout.children, inserted];
        return { ...layout, children, sizes: evenSizes(children.length) };
    }
    return { type: 'split', direction, children: [layout, inserted], sizes: [50, 50] };
}

function insertNextTo(node: Layout, inserted: Layout, targetId: string, direction: LayoutDirection, before = false): Layout {
    if (node.type === 'pane') {
        if (node.paneId !== targetId) {
            return node;
        }
        return { type: 'split', direction, children: before ? [inserted, node] : [node, inserted], sizes: [50, 50] };
    }

    const index = node.children.findIndex((child) => child.type === 'pane' && child.paneId === targetId);
    if (index >= 0 && node.direction === direction) {
        const children = [...node.children];
        children.splice(before ? index : index + 1, 0, inserted);
        const sizes = [...node.sizes];
        const half = sizes[index] / 2;
        sizes.splice(index, 1, half, half);
        return { ...node, children, sizes };
    }

    return { ...node, children: node.children.map((child) => insertNextTo(child, inserted, targetId, direction, before)) };
}

export type DropEdge = 'left' | 'right' | 'top' | 'bottom' | 'swap';

function swapLeaves(node: Layout, a: string, b: string): Layout {
    if (node.type === 'pane') {
        return node.paneId === a ? leaf(b) : node.paneId === b ? leaf(a) : node;
    }
    return { ...node, children: node.children.map((child) => swapLeaves(child, a, b)) };
}

// Moves a pane next to another pane of the same layout, or swaps the two. Returns the layout
// unchanged when either pane is missing or they are the same pane.
export function movePane(layout: Layout | null, paneId: string, targetId: string, edge: DropEdge): Layout | null {
    const ids = paneIds(layout);
    if (!layout || paneId === targetId || !ids.includes(paneId) || !ids.includes(targetId)) {
        return layout;
    }
    if (edge === 'swap') {
        return swapLeaves(layout, paneId, targetId);
    }
    const rest = removePane(layout, paneId);
    const direction: LayoutDirection = edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical';
    return rest ? insertNextTo(rest, leaf(paneId), targetId, direction, edge === 'left' || edge === 'top') : layout;
}

// Puts panes that are not in this layout yet, in their own arrangement, on the edge of a pane they
// were dropped on; dropped on the middle of a pane, or with no pane to drop on, they go to the right.
export function placeLayout(layout: Layout | null, placed: Layout, targetId: string | null, edge: DropEdge): Layout {
    if (!layout) {
        return placed;
    }
    if (!targetId || !paneIds(layout).includes(targetId)) {
        return append(layout, placed, 'horizontal');
    }
    const direction: LayoutDirection = edge === 'top' || edge === 'bottom' ? 'vertical' : 'horizontal';
    return insertNextTo(layout, placed, targetId, direction, edge === 'left' || edge === 'top');
}

export function removePane(layout: Layout | null, paneId: string): Layout | null {
    if (!layout) {
        return null;
    }
    if (layout.type === 'pane') {
        return layout.paneId === paneId ? null : layout;
    }

    const kept: { child: Layout; size: number }[] = [];
    layout.children.forEach((child, index) => {
        const next = removePane(child, paneId);
        if (next) {
            kept.push({ child: next, size: layout.sizes[index] ?? 0 });
        }
    });

    if (kept.length === 0) {
        return null;
    }
    if (kept.length === 1) {
        return kept[0].child;
    }
    return { ...layout, children: kept.map((entry) => entry.child), sizes: normalizeSizes(kept.map((entry) => entry.size)) };
}

export function normalizeSizes(sizes: number[]): number[] {
    const valid = sizes.map((size) => (Number.isFinite(size) && size > 0 ? size : 0));
    const total = valid.reduce((sum, size) => sum + size, 0);
    if (total <= 0) {
        return evenSizes(sizes.length);
    }
    return valid.map((size) => (size / total) * 100);
}

export function isValidLayout(value: unknown): value is Layout {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const node = value as Partial<Layout>;
    if (node.type === 'pane') {
        return typeof (node as { paneId?: unknown }).paneId === 'string';
    }
    if (node.type === 'split') {
        const split = node as Partial<LayoutSplit>;
        return (
            (split.direction === 'horizontal' || split.direction === 'vertical') &&
            Array.isArray(split.children) &&
            split.children.length >= 2 &&
            Array.isArray(split.sizes) &&
            split.sizes.length === split.children.length &&
            split.sizes.every((size) => typeof size === 'number' && Number.isFinite(size)) &&
            split.children.every(isValidLayout)
        );
    }
    return false;
}

export function samePanes(a: Layout | null, b: Layout | null): boolean {
    const left = paneIds(a).sort();
    const right = paneIds(b).sort();
    return left.length === right.length && left.every((id, index) => id === right[index]);
}
