import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * A second entry: the reader.
 *
 * `vite build --mode share` builds `src/share` — the read-only half of the
 * app, the same markdown pipeline the editor renders from — into
 * `server/public`, which the server serves at `/` and `/{id}`. It is a mode
 * rather than a second input because the two builds go to different places:
 * the app's to `dist` for Tauri, the reader's into the server. See
 * plans/public-plan-pages.md.
 */
const share = (mode: string) =>
  mode === "share"
    ? {
        root: "src/share",
        // Nothing in `public/` belongs to a public page; the reader carries
        // what it needs in its bundle.
        publicDir: false as const,
        build: { outDir: "../../server/public", emptyOutDir: true },
      }
    : {};

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [react()],
  ...share(mode),

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
