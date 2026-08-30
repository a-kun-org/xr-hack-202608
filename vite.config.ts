import { defineConfig } from "vite";

export default defineConfig({
  // AWS (traffic.a-kun-xr.com) は "/"。GitHub Pages は VITE_BASE=/xr-hack-202608/
  base: process.env.VITE_BASE ?? "/",
  publicDir: "public",
  worker: {
    format: "es",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
