import { defineConfig } from "vite";

export default defineConfig({
  base: "/xr-hack-202608/",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
