import { defineConfig } from "vitest/config";

export default defineConfig({
  // Os testes exercitam todos os grupos; a configuração real (só Documentação) tem testes próprios.
  test: { testTimeout: 60_000, hookTimeout: 60_000, env: { REPO_SCORE_ENABLED_GROUPS: "all" } },
  plugins: [
    {
      // `import tpl from "x.html|.sh|.md"` devolve o texto, igual ao loader do esbuild no build.
      name: "html-as-text",
      enforce: "pre",
      transform(code, id) {
        if (/\.(html|sh|md)$/.test(id)) return { code: `export default ${JSON.stringify(code)};`, map: null };
        return null;
      },
    },
  ],
});
