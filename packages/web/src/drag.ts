import type { DropEdge } from '@voltran/shared';

export const PANE_DRAG_TYPE = 'application/x-voltran-pane';
export const SESSION_DRAG_TYPE = 'application/x-voltran-session';
export const PROJECT_DRAG_TYPE = 'application/x-voltran-project';

const CENTRE = [0.3, 0.7];

export function dropEdgeAt(x: number, y: number, width: number, height: number): DropEdge {
    if (width <= 0 || height <= 0) {
        return 'swap';
    }
    const rx = x / width;
    const ry = y / height;
    if (rx > CENTRE[0] && rx < CENTRE[1] && ry > CENTRE[0] && ry < CENTRE[1]) {
        return 'swap';
    }
    const distances: [DropEdge, number][] = [
        ['left', rx],
        ['right', 1 - rx],
        ['top', ry],
        ['bottom', 1 - ry],
    ];
    return distances.reduce((best, entry) => (entry[1] < best[1] ? entry : best))[0];
}
