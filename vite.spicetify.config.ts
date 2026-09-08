// vite.spicetify.config.ts — build de la custom app Spicetify.
//
// Sortie : UN fichier `spicetify/dist/index.js` en IIFE, terminé par le
// `const render = ...` global que le routeur de custom app appelle (même
// contrat que Marketplace). CSS et shaders sont inlinés : rien à charger.

import { defineConfig, type Plugin } from "vite";

// Le routeur de custom app appelle un `render()` GLOBAL. On l'ajoute après la
// minification (generateBundle passe après renderChunk) : `output.footer` de
// Rollup se fait manger par le pipeline lib de Vite.
function renderTail(): Plugin {
  return {
    name: "spicetify-render-tail",
    generateBundle(_opts, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === "chunk" && file.isEntry) file.code += "\nconst render = () => vizApp.render();\n";
      }
    },
  };
}

export default defineConfig({
  plugins: [renderTail()],
  define: {
    // Chemin réel du dépôt, gravé dans l'overlay "pont hors ligne".
    __VIZ_BRIDGE_CMD__: JSON.stringify(`cd ${process.cwd()} && node bridge/viz-bridge.mjs`),
  },
  build: {
    target: "es2022",
    outDir: "spicetify/dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: "spicetify/src/app.ts",
      formats: ["iife"],
      name: "vizApp",
      fileName: () => "index.js",
    },
    rollupOptions: { output: { extend: false } },
  },
});
