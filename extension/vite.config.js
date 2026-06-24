import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function wrapContentScripts() {
  const contentScriptFiles = new Set([
    "contentScraper.js",
    "selectionButton.js",
  ]);

  return {
    name: "wrap-content-scripts",
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type !== "chunk" || !contentScriptFiles.has(item.fileName)) {
          continue;
        }

        item.code = `(() => {\n${item.code}\n})();`;
      }
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), wrapContentScripts()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: "popup.html",
        options: "options.html",
        background: "src/background.js",
        contentScraper: "src/scraper/contentScraper.js",
        selectionButton: "src/content/selectionButton.js",
      },
      output: {
        entryFileNames: (chunkInfo) => (
          chunkInfo.name === "background"
            ? "background.js"
            : chunkInfo.name === "contentScraper"
              ? "contentScraper.js"
              : chunkInfo.name === "selectionButton"
                ? "selectionButton.js"
            : "assets/[name]-[hash].js"
        ),
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
