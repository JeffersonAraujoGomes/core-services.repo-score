import type { ReportData } from "../analyze.js";
// O template é embutido no bundle pelo esbuild (loader de texto); em dev, o vitest usa o mesmo import.
import template from "../../ui/report.html";

/** JSON seguro para dentro de <script type="application/json">: sem `</script>`, `<!--` nem separadores de linha. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function renderReport(data: ReportData): string {
  const marker = "__REPORT_DATA__";
  const at = template.indexOf(marker);
  if (at < 0) throw new Error("template do relatório sem marcador de dados");
  // slice em vez de replace(): o JSON pode conter `$&` e similares, que replace() interpretaria.
  return template.slice(0, at) + safeJson(data) + template.slice(at + marker.length);
}
