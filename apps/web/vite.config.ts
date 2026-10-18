import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const mcpDir = resolve(__dirname, "../../packages/mcp-server");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { fs: { allow: ["../.."] } },
  define: {
    // Local paths for the "Conectar agente" command (dev only; a published MCP package replaces this).
    "import.meta.env.VITE_MCP_TSX": JSON.stringify(resolve(mcpDir, "node_modules/.bin/tsx")),
    "import.meta.env.VITE_MCP_ENTRY": JSON.stringify(resolve(mcpDir, "src/index.ts")),
  },
});
