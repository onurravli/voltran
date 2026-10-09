import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const daemonPort = process.env.VOLTRAN_PORT || '4747';

export default defineConfig({
    plugins: [react()],
    server: {
        host: 'localhost',
        port: 5173,
        strictPort: true,
        proxy: {
            '/api': { target: `http://127.0.0.1:${daemonPort}` },
            '/auth': { target: `http://127.0.0.1:${daemonPort}` },
            '/ws': { target: `ws://127.0.0.1:${daemonPort}`, ws: true },
        },
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        chunkSizeWarningLimit: 1500,
    },
});
