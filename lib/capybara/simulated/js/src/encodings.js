// The Encoding Standard's labels, for `document.characterSet` / `charset` / `inputEncoding` and a form's submission
// encoding: a declared charset label (from `<meta charset>` / Content-Type / `accept-charset`) → its encoding's name.

// Encoding §4.1 "get an encoding" (native, text_codec.rs: leading/trailing ASCII whitespace stripped, ASCII
// case-insensitive — U+212A KELVIN SIGN is no `k`). Returns the canonical name or null (unsupported / failure).
//
// `fromMeta` applies HTML's meta-charset overrides (only for `<meta>`, not an
// HTTP charset): UTF-16BE/UTF-16LE → UTF-8 (the doc was ASCII-decoded to read
// the meta, so it can't really be UTF-16), and x-user-defined → windows-1252.
export function getEncoding(label, fromMeta) {
  const name = globalThis.__dom.encodingName(String(label));
  if (!name) return null;
  if (fromMeta) {
    if (name === 'UTF-16BE' || name === 'UTF-16LE') return 'UTF-8';
    if (name === 'x-user-defined') return 'windows-1252';
  }
  return name;
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
  const docEnc = doc && doc._charsetOverride && getEncoding(doc._charsetOverride);
  return (docEnc && docEnc !== 'UTF-16BE' && docEnc !== 'UTF-16LE') ? docEnc : 'UTF-8';
}
