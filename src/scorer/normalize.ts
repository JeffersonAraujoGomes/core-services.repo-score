/**
 * Normalização por KLOC (V11). Código gerado (*.pb.go etc.) deve ser excluído
 * pelo coletor antes de chegar aqui: não conta nem no numerador nem no KLOC (V12).
 */
export function perKloc(count: number, loc: number): number {
  if (!Number.isFinite(loc) || loc <= 0) throw new RangeError("loc deve ser > 0");
  if (count < 0) throw new RangeError("count deve ser >= 0");
  return count / (loc / 1000);
}
