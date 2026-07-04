import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" → relative asset paths, so the built bundle loads correctly from an
// object-storage static-hosting endpoint host (no assumed domain root).
export default defineConfig({
  base: "./",
  plugins: [react()],
});
