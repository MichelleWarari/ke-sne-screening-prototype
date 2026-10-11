import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// base "./" lets the built site work from a sub-path such as GitHub Pages (user.github.io/<repo>/).
export default defineConfig({
  base: "./",
  server: {host: true, allowedHosts: true },
  preview: { host: true, allowedHosts: true },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate", // new versions install in the background and apply on the next open
      includeAssets: ["favicon.svg"],
      workbox: {
        // Precache the whole app shell, including the bundled fonts, so it opens with no network.
        globPatterns: ["**/*.{js,css,html,svg,png,woff,woff2}"],
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
      },
      manifest: {
        name: "KE SNE Screening Prototype",
        short_name: "SNE Screener",
        description: "Offline-first dyslexia and dyscalculia functional screening for Kenyan primary schools (CBC).",
        theme_color: "#5a6016",
        background_color: "#effee4",
        display: "standalone",
        orientation: "portrait",
        scope: "./",
        start_url: "./",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "pwa-maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
});
