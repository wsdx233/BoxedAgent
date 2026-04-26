import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/@codemirror") || id.includes("node_modules/@uiw")) return "codemirror";
          if (id.includes("node_modules/react-markdown") || id.includes("node_modules/remark") || id.includes("node_modules/mdast") || id.includes("node_modules/micromark") || id.includes("node_modules/unified")) return "markdown";
          if (id.includes("node_modules/@xterm")) return "xterm";
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom") || id.includes("node_modules/scheduler")) return "react";
        }
      }
    }
  },
  server: {
    proxy: {
      "/api": { target: "http://localhost:8080", changeOrigin: true, timeout: 0, proxyTimeout: 0 },
      "/ws": { target: "ws://localhost:8080", ws: true, changeOrigin: true },
      "/codeserver": {
        target: "http://localhost:8080",
        ws: true,
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0
      }
    }
  }
});
