// The Encoding Standard's labels, for TextDecoder and an XHR response's charset: a label → its encoding's name.

import { dom } from './engine.js';

// Encoding §4.1 "get an encoding" (native, text_codec.rs: leading/trailing ASCII whitespace stripped, ASCII
// case-insensitive — U+212A KELVIN SIGN is no `k`). Returns the canonical name or null (unsupported / failure).
export function getEncoding(label) {
  return dom.encodingName(String(label));
}
