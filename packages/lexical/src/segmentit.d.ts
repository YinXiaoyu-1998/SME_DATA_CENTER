/**
 * `segmentit` ships a CommonJS bundle whose entry re-exports another file through
 * `module.exports = require(...)`, so Node's ESM named-export detection cannot see its members.
 * The package also ships no type declarations. This shim declares the default-import shape the
 * tokenizer actually uses.
 */
declare module "segmentit" {
  export interface Segmenter {
    doSegment(text: string, options: { simple: true }): string[];
    doSegment(text: string, options?: { simple?: boolean }): Array<string | { w: string }>;
  }

  const segmentit: {
    Segment: new () => unknown;
    useDefault(segment: unknown): Segmenter;
  };

  export default segmentit;
}
