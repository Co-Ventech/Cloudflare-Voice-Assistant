import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  // Editing docs must never reload the page (it cut off a live call once).
  server: { watch: { ignored: ["**/*.md"] } },
  plugins: [react(), tailwindcss(), cloudflare()],
});
