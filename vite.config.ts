import { defineConfig } from "vite";

export default defineConfig({
  base: "/xr-hack-202608/",
  publicDir: "public",
  worker: {
    format: "es",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
