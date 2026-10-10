import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: '訪問ルート',
        short_name: '訪問ルート',
        lang: 'ja',
        start_url: '/',
        display: 'standalone',
        background_color: '#f7f1ec',
        theme_color: '#e8735f',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: { navigateFallback: '/index.html', globPatterns: ['**/*.{js,css,html,svg}'] },
    }),
  ],
  server: { port: 5173 },
});
