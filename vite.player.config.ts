import { defineConfig } from "vite";

// The replay player: rrweb-player (pinned) as one script plus one stylesheet, served by the feedback server.
export default defineConfig({
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: false,
    cssCodeSplit: false,
    lib: { entry: "src/replay/player.ts", formats: ["iife"], name: "ReactFeedbackPlayer", fileName: () => "player.js", cssFileName: "player" },
  },
});
