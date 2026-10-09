/** Escapa metacaracteres de regex em um trecho literal. */
const esc = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/**
 * Pathspec no estilo do `git diff -- <pathspec>` (o mesmo que os hooks do SDD usam):
 * `*` e `**` casam qualquer coisa, inclusive `/`; um caminho sem curinga casa o arquivo ou a árvore.
 */
export function pathspecToRegex(spec: string): RegExp {
  const s = spec.replace(/^\.\//, "").replace(/\/+$/, "");
  const body = esc(s).replace(/\*\*?/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}(?:/.*)?$`);
}

/** Glob no estilo gitignore: `*` não atravessa `/`, `**` atravessa. */
export function globToRegex(glob: string): RegExp {
  let g = glob.replace(/^\.\//, "");
  const anchored = g.startsWith("/");
  if (anchored) g = g.slice(1);
  const dirOnly = g.endsWith("/");
  if (dirOnly) g = g.replace(/\/+$/, "");
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        i += 1;
        if (g[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += esc(c);
  }
  const prefix = anchored || g.includes("/") ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${out}${dirOnly ? "/.*" : "(?:/.*)?"}$`);
}
