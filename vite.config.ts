import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

const isTauriBuild = Boolean(process.env.TAURI_ENV_PLATFORM);

function tauriLargeResourcePlugin() {
  return {
    name: "tauri-large-resource",
    apply: "build" as const,
    closeBundle() {
      if (!isTauriBuild) return;
      const embeddedModelPath = path.resolve(__dirname, "dist/vendor/irodori-tts-webgpu");
      if (fs.existsSync(embeddedModelPath)) {
        fs.rmSync(embeddedModelPath, { recursive: true, force: true });
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), tauriLargeResourcePlugin()],
  publicDir: "img",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@pne/player-core": path.resolve(__dirname, "packages/player-core/src/index.ts")
    }
  },
  clearScreen: false,
  server: {
    // Allow a phone on the same home network to open the dev preview.
    host: true,
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] }
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "es2022",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG)
  },
  test: { environment: "node", include: ["packages/**/*.test.ts", "src/**/*.test.ts"] }
});
