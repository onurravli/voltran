import type { FolderEntry, FolderListing } from '@voltran/shared';

export interface TreeRow {
    path: string;
    name: string;
    kind: FolderEntry['kind'];
    depth: number;
    expanded: boolean;
}

export function childPath(folder: string, name: string): string {
    return folder ? `${folder}/${name}` : name;
}

export function parentPath(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash < 0 ? '' : path.slice(0, slash);
}

// The rows a tree shows: each listed folder's entries, and under an expanded folder its own, once
// they have been read.
export function treeRows(listings: Record<string, FolderListing>, expanded: ReadonlySet<string>, folder = '', depth = 0): TreeRow[] {
    const listing = listings[folder];
    if (!listing) {
        return [];
    }
    return listing.entries.flatMap((entry) => {
        const path = childPath(folder, entry.name);
        const open = entry.kind === 'folder' && expanded.has(path);
        const row: TreeRow = { path, name: entry.name, kind: entry.kind, depth, expanded: open };
        return open ? [row, ...treeRows(listings, expanded, path, depth + 1)] : [row];
    });
}

// The folders whose listing stays worth reading: the root and every expanded folder whose parents
// are all expanded too.
export function shownFolders(expanded: ReadonlySet<string>): string[] {
    return [
        '',
        ...[...expanded].filter((path) => path.split('/').every((_, index, parts) => expanded.has(parts.slice(0, index + 1).join('/')))),
    ];
}
