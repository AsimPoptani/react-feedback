import { defineConfig } from "vite";

// The recorder: one self-contained script (rrweb's record, pinned in package.json). Injected into a shared page, or loaded by the inbox.
export default defineConfig({
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: false,
    lib: { entry: "src/replay/recorder.ts", formats: ["iife"], name: "ReactFeedbackRecorder", fileName: () => "recorder.js" },
  },
});
