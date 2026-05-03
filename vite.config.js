import { defineConfig } from "vite";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 4173;

export default defineConfig({
  base: "/",
  root: __dirname,
  publicDir: false,
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    target: "esnext",
    rollupOptions: {
      input: {
        index:     resolve(__dirname, "index.html"),
        connexion: resolve(__dirname, "connexion.html"),
        details:   resolve(__dirname, "details.html"),
        video:     resolve(__dirname, "video.html"),
        film:      resolve(__dirname, "film.html"),
        series:    resolve(__dirname, "series.html"),
        recherche: resolve(__dirname, "recherche.html"),
        maliste:   resolve(__dirname, "ma-liste.html"),
        profil:    resolve(__dirname, "profil.html"),
      },
    },
  },
  server: {
    port: Number(process.env.PORT) || 5173,
    host: "0.0.0.0",
  },
  preview: {
    port,
    host: "0.0.0.0",
  },
});
