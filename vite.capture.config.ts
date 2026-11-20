import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The capture script injected into a shared artifact: the widget's capture with React and the CSS inside, driven by its parent page.
export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: false,
    lib: { entry: "src/widget/capture.tsx", formats: ["iife"], name: "ReactFeedbackCapture", fileName: () => "capture.js" },
  },
});
