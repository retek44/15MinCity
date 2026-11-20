/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API = process.env.REACH15_API ?? "http://localhost:8080";
const TILES = process.env.REACH15_TILES ?? "http://localhost:3000";

const proxy = {
  "/api": { target: API, changeOrigin: true },
  "/tiles": { target: TILES, changeOrigin: true, rewrite: (path: string) => path.replace(/^\/tiles/, "") },
};

export default defineConfig({
  plugins: [react()],
  // MapLibre 6 loads its worker relative to its own module URL; pre-bundling moves the module
  // into .vite/deps and the worker is then not found.
  optimizeDeps: { exclude: ["maplibre-gl"] },
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 1100,
    rolldownOptions: {
      output: {
        // Libraries in their own chunks: a release that changes only the app (most of them) keeps
        // the browser's cached MapLibre and React, about 90 % of the JavaScript.
        advancedChunks: {
          groups: [
            // Module ids use forward slashes on every platform.
            { name: "maplibre", test: /node_modules\/maplibre-gl\// },
            { name: "react", test: /node_modules\/(react|react-dom|scheduler)\// },
            { name: "vendor", test: /node_modules\// },
          ],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
