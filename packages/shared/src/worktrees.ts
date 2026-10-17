const MAX_BRANCH = 60;

export function branchFromTitle(title: string): string {
    const slug = title
        .replace(/ı/g, 'i')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug.slice(0, MAX_BRANCH).replace(/-+$/, '');
}
