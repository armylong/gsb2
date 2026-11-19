/** Stable frame identity helpers. Shared by import, pack, export and tests. */

/**
 * Deterministic, collision-resistant frame id derived from the decoded pixel
 * content and the source scope. Import order, file order and renaming the
 * file in place do not affect it. Two byte-identical files uploaded from
 * different directories produce different ids because `sourceKey` differs.
 */
export function computeFrameId(contentHash: string, sourceKey: string): string {
  // FNV-1a style 64-bit-ish mix over two 32-bit lanes. Good enough for ids and
  // dependency-free; uniqueness across a project is also protected by the
  // duplicate check in the packer, which reports rather than overwrites.
  const input = `${contentHash}\u0000${sourceKey}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + c) >>> 0;
    h2 = Math.imul(h2 ^ (h2 >>> 15), 0x2c1b3c6d) >>> 0;
  }
  const part = (value: number) => value.toString(16).padStart(8, '0');
  return `f_${part(h1)}${part(h2)}`;
}

/**
 * Normalize a user-visible source path into the key that scopes identity.
 * Different directories with the same file name stay distinct.
 */
export function normalizeSourceKey(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

export function sourceBaseName(path: string): string {
  const normalized = normalizeSourceKey(path);
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}
