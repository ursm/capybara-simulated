// The XML / XHTML parser is the engine's, and so is what it builds (xml_parse.rs `xmlBuild`: namespace-aware, `<tag/>`
// on any element, names' case kept, processing instructions and CDATA sections as nodes, a `<script>` / `<style>` body
// parsed as markup, a DOCTYPE's literal general entities expanded); the bindings run the steps of the elements it names
// (html-tree-builder.js `builtSteps`: an inline handler, an attribute's appended steps, an element's insertion steps).

export function installXmlParser({ inertTemplateDocFor, builtSteps }) {
  // `src` parsed into `doc` — every node its own — its element, and the comments, processing instructions and doctype
  // around it; a `<parsererror>` one where it is not well-formed.
  function parseXmlInto(doc, src) {
    const made = globalThis.__dom.xmlBuild(String(src == null ? '' : src), -1, doc, inertTemplateDocFor(doc));
    if (made !== undefined) builtSteps(made, 1);
  }
  // …and `src` parsed in `context`'s namespace scope (XML fragment parsing): its top-level nodes — text and more than one
  // element among them — or, where it is not well-formed, null (the caller throws a SyntaxError).
  function parseXmlFragment(src, context) {
    const doc = context._ownerDoc || globalThis.document;
    const made = globalThis.__dom.xmlBuild(String(src == null ? '' : src), context._nid, doc, inertTemplateDocFor(doc));
    if (made === null) return null;
    if (made === undefined) return [];
    const count = made[0];
    builtSteps(made, 1 + count);
    return made.slice(1, 1 + count);
  }

  return { parseXmlInto, parseXmlFragment };
}
