/**
 * Typed without resolveJsonModule, which would infer literal types for every
 * one of ~5,800 tag entries and blow the compiler's Map limit — the same
 * failure the catalog hit.
 */
declare const constants: {
  albums: number;
  axisSd: Record<string, number>;
  meanIdf: number;
  nonMusical: string[];
  tagIdf: Record<string, number>;
};
export default constants;
