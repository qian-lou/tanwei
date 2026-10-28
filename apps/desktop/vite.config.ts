import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/renderer", import.meta.url)),
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
  base: "./",
  build: {
    target: ["chrome111", "edge111", "firefox114", "safari16.4"],
    outDir: "dist/renderer",
    emptyOutDir: false,
    sourcemap: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/renderer/test/setup.ts"],
    exclude: ["node_modules/**", "dist/**", "release/**"],
  },
});
