import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The drop-in script: one self-contained file with React and the CSS inside.
export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: false,
    lib: { entry: "src/widget/embed.tsx", formats: ["iife"], name: "ReactFeedbackEmbed", fileName: () => "embed.js" },
  },
});
