// The Encoding Standard's labels, for TextDecoder, an XHR response's charset and a form's submission encoding: a
// label → its encoding's name.

// Encoding §4.1 "get an encoding" (native, text_codec.rs: leading/trailing ASCII whitespace stripped, ASCII
// case-insensitive — U+212A KELVIN SIGN is no `k`). Returns the canonical name or null (unsupported / failure).
export function getEncoding(label) {
  return globalThis.__dom.encodingName(String(label));
}

// HTML "the form's submission character encoding": the first SUPPORTED label in
// `accept-charset` (ASCII-whitespace/comma separated), else the document's own
// encoding, else UTF-8. UTF-16BE/LE are not usable for submission → coerced to
// UTF-8 (per spec). Used for the `_charset_` control value and the URL/body encode.
export function formSubmissionEncoding(form) {
  const ac = form && form._attrs && form._attrs['accept-charset'];
  if (ac) {
    for (const label of String(ac).split(/[\t\n\f\r ,]+/)) {
      if (!label) continue;
      const enc = getEncoding(label);
      if (enc) return (enc === 'UTF-16BE' || enc === 'UTF-16LE') ? 'UTF-8' : enc;
    }
  }
  const doc = (form && form.ownerDocument) || globalThis.document;
  const docEnc = doc ? doc.characterSet : 'UTF-8';
  return (docEnc !== 'UTF-16BE' && docEnc !== 'UTF-16LE') ? docEnc : 'UTF-8';
}
