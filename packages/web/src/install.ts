import { reportError, useUi } from './store.ts';

interface InstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let offer: InstallPromptEvent | null = null;

// Chrome offers to install a page as an app once it qualifies, and only through this event; it fires
// once per load (again after a dismissal), so it is caught before the app renders.
export function watchInstallOffer(): void {
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        offer = event as InstallPromptEvent;
        useUi.getState().setInstallable(true);
    });
    window.addEventListener('appinstalled', () => {
        offer = null;
        useUi.getState().setInstallable(false);
        useUi
            .getState()
            .showToast('Voltran is installed. To keep it in the Dock, right-click its icon → Options → Keep in Dock');
    });
}

export function installApp(): void {
    const pending = offer;
    if (!pending) {
        return;
    }
    offer = null;
    useUi.getState().setInstallable(false);
    pending.prompt().catch(reportError);
}
