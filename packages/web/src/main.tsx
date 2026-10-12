import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App.tsx';
import { activeThemeId, useUi, type UiState } from './store.ts';
import { themeById, themeProperties } from './themes.ts';

const THEME_CACHE_KEY = 'voltran.theme';

function applyTheme(state: UiState): void {
    for (const [name, value] of Object.entries(themeProperties(themeById(activeThemeId(state))))) {
        document.documentElement.style.setProperty(name, value);
    }
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({
        appearance: state.appearance,
        dark: themeProperties(themeById(state.themeIds.dark)),
        light: themeProperties(themeById(state.themeIds.light)),
    }));
}

applyTheme(useUi.getState());
useUi.subscribe((state, previous) => {
    if (activeThemeId(state) !== activeThemeId(previous) || state.appearance !== previous.appearance || state.themeIds !== previous.themeIds) {
        applyTheme(state);
    }
});

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
