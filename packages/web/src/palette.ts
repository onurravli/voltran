export interface Searchable {
    label: string;
}

export function filterItems<T extends Searchable>(items: T[], query: string): T[] {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
        return items;
    }
    const ranked: { item: T; rank: number; position: number; order: number }[] = [];
    items.forEach((item, order) => {
        const label = item.label.toLowerCase();
        if (!tokens.every((token) => label.includes(token))) {
            return;
        }
        const position = label.indexOf(tokens[0]);
        const atWordStart = position === 0 || /[\s(:/-]/.test(label[position - 1]);
        ranked.push({ item, rank: position === 0 ? 0 : atWordStart ? 1 : 2, position, order });
    });
    ranked.sort((a, b) => a.rank - b.rank || a.position - b.position || a.order - b.order);
    return ranked.map((entry) => entry.item);
}
