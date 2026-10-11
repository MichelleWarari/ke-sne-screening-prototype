import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" lets the built site work from a sub-path such as GitHub Pages (user.github.io/<repo>/).
export default defineConfig({
  base: "./",
  plugins: [react()],
});
