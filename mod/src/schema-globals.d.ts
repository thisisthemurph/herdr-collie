// The mod imports @collie/schema for types only (erased when bundled), but typechecking still
// reads the schema's runtime files, which use these Web globals. The mod never calls them.
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };
