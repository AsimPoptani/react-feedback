import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The library: ESM for React apps. react and react-dom stay external (peer dependencies).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    lib: { entry: "src/widget/index.ts", formats: ["es"], fileName: () => "index.js" },
    rollupOptions: { output: { banner: '"use client";' }, external: ["react", "react-dom", "react/jsx-runtime", "modern-screenshot"] },
  },
});
