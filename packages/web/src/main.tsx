import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App.tsx';
import { useUi } from './store.ts';
import { themeById, themeProperties } from './themes.ts';

const THEME_CACHE_KEY = 'voltran.theme';

function applyTheme(id: string): void {
    const properties = themeProperties(themeById(id));
    for (const [name, value] of Object.entries(properties)) {
        document.documentElement.style.setProperty(name, value);
    }
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(properties));
}

applyTheme(useUi.getState().themeId);
useUi.subscribe((state, previous) => {
    if (state.themeId !== previous.themeId) {
        applyTheme(state.themeId);
    }
});

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
