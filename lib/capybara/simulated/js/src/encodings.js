// The Encoding Standard's labels, for TextDecoder, an XHR response's charset and a form's submission encoding: a
// label → its encoding's name.

// Encoding §4.1 "get an encoding" (native, text_codec.rs: leading/trailing ASCII whitespace stripped, ASCII
// case-insensitive — U+212A KELVIN SIGN is no `k`). Returns the canonical name or null (unsupported / failure).
export function getEncoding(label) {
  return globalThis.__dom.encodingName(String(label));
}

// HTML "picking an encoding for the form": the first SUPPORTED label in `accept-charset` (ASCII-whitespace / comma
// separated), else the document's own encoding — as the Encoding Standard's "get an output encoding" has it: replacement
// and UTF-16BE/LE encode nothing and are UTF-8. Used for the `_charset_` control value and the URL/body encode.
export function formSubmissionEncoding(form) {
  const ac = form && form._attrs && form._attrs['accept-charset'];
  let encoding = null;
  if (ac) {
    for (const label of String(ac).split(/[\t\n\f\r ,]+/)) {
      if (label && (encoding = getEncoding(label))) break;
    }
  }
  if (!encoding) {
    const doc = (form && form.ownerDocument) || globalThis.document;
    encoding = doc ? doc.characterSet : 'UTF-8';
  }
  return encoding === 'replacement' || encoding === 'UTF-16BE' || encoding === 'UTF-16LE' ? 'UTF-8' : encoding;
}
