import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { PROTOCOL_SOURCES, UI_SOURCES, sourceHash } from '../daemon/src/source-hash.ts';

const daemonPort = process.env.VOLTRAN_PORT || '4747';
const packagesDir = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ command }) => {
    const version =
        command === 'build'
            ? { ui: sourceHash(packagesDir, UI_SOURCES), protocol: sourceHash(packagesDir, PROTOCOL_SOURCES) }
            : null;
    return {
        plugins: [
            react(),
            {
                name: 'voltran-version',
                apply: 'build',
                generateBundle() {
                    this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify(version)}\n` });
                },
            },
        ],
        define: {
            __VOLTRAN_UI__: JSON.stringify(version?.ui ?? 'dev'),
        },
        server: {
            host: 'localhost',
            port: 4774,
            strictPort: true,
            proxy: {
                '/api': { target: `http://127.0.0.1:${daemonPort}` },
                '/ws': { target: `ws://127.0.0.1:${daemonPort}`, ws: true },
            },
        },
        build: {
            outDir: 'dist',
            emptyOutDir: true,
            chunkSizeWarningLimit: 3000,
        },
    };
});
