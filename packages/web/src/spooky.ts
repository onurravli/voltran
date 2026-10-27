const SEQUENCE = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
const BATS = 13;
const FLIGHT_MS = 4200;

export function sequenceMatcher(sequence: readonly string[] = SEQUENCE): (key: string) => boolean {
    let typed: string[] = [];
    return (key) => {
        typed = [...typed, key.length === 1 ? key.toLowerCase() : key].slice(-sequence.length);
        if (typed.length === sequence.length && typed.every((entry, index) => entry === sequence[index])) {
            typed = [];
            return true;
        }
        return false;
    };
}

export function isHalloween(date: Date): boolean {
    return date.getMonth() === 9 && date.getDate() === 31;
}

export function quietLabel(date: Date): string {
    return isHalloween(date) ? 'Nothing haunts you 👻' : 'Nothing needs you';
}

function releaseBats(toast: (message: string) => void): void {
    toast('🦇 Happy haunting');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return;
    }
    const sky = document.createElement('div');
    sky.className = 'bats';
    sky.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < BATS; index += 1) {
        const bat = document.createElement('span');
        bat.className = 'bat';
        bat.textContent = '🦇';
        bat.style.setProperty('--bat-top', `${Math.round(Math.random() * 80 + 5)}%`);
        bat.style.setProperty('--bat-delay', `${Math.round(Math.random() * 1200)}ms`);
        bat.style.setProperty('--bat-size', `${Math.round(Math.random() * 18 + 18)}px`);
        bat.style.setProperty('--bat-swoop', `${Math.round(Math.random() * 160 - 80)}px`);
        sky.append(bat);
    }
    document.body.append(sky);
    setTimeout(() => sky.remove(), FLIGHT_MS);
}

export function installSpooky(toast: (message: string) => void): () => void {
    const matches = sequenceMatcher();
    const onKeyDown = (event: KeyboardEvent): void => {
        if (!event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey && matches(event.key)) {
            releaseBats(toast);
        }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
}
