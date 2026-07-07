import { defineConfig, type Plugin } from "vite";

// SharedArrayBuffer exige un contexte "cross-origin isolated" -> headers COOP/COEP.
// Le PIÈGE (vérifié) : il faut les poser en DEV **et** en PREVIEW, sinon
// crossOriginIsolated est true en dev et false en preview/build.
function crossOriginIsolation(): Plugin {
  const headers: Record<string, string> = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  const apply = (res: { setHeader(k: string, v: string): void }) => {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  };
  return {
    name: "cross-origin-isolation",
    configureServer(server) {
      server.middlewares.use((_req, res, next) => { apply(res); next(); });
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => { apply(res); next(); });
    },
  };
}

export default defineConfig({
  plugins: [crossOriginIsolation()],
  server: { port: 5173, strictPort: true },
  preview: { port: 5174, strictPort: true },
  build: {
    target: "es2022",
    // Le worklet DOIT être émis comme fichier same-origin (jamais inliné en
    // data:base64) -> build déterministe + portable (Firefox/Safari).
    assetsInlineLimit: (file: string) => (file.includes(".worklet.") ? false : undefined),
  },
});
