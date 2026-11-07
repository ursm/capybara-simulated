(() => {
  // Every `_` name a page can see: on each interface object and its prototype, and on an instance of each interface
  // a page can make here — own names, JSON keys, for…in keys. (Not ECMAScript's own: `Object.prototype.__proto__`, …)
  const found = new Set();
  const ecmascript = new Set(Object.getOwnPropertyNames(Object.prototype));
  // (…and a symbol of the agent's registry the driver keys a brand by, which a page can make and forge: `@csim:Name`)
  const internal = (k) => (typeof k === 'string' ? k[0] === '_' && !ecmascript.has(k) : Symbol.keyFor(k)?.startsWith('csim') === true);
  const named = (k) => (typeof k === 'string' ? k : '@' + Symbol.keyFor(k).replace(/\./g, ':'));
  const ifaces = Object.getOwnPropertyNames(globalThis).filter((n) => /^[A-Z]/.test(n) && typeof globalThis[n] === 'function' && globalThis[n].prototype);
  for (const name of ifaces) {
    const I = globalThis[name];
    for (const k of Reflect.ownKeys(I)) if (internal(k)) found.add(`${name}.${named(k)}`);
    for (const k of Reflect.ownKeys(I.prototype)) if (internal(k)) found.add(`${name}.prototype.${named(k)}`);
  }
  const xml = document.implementation.createDocument(null, 'r', null);
  const host = document.createElement('div');
  const instances = {
    Text: () => new Text('a'), Comment: () => new Comment('a'), CDATASection: () => xml.createCDATASection('a'),
    ProcessingInstruction: () => document.createProcessingInstruction('t', 'd'), Attr: () => document.createAttribute('a'),
    DocumentType: () => document.doctype || document.implementation.createDocumentType('html', '', ''),
    DocumentFragment: () => new DocumentFragment(), ShadowRoot: () => host.attachShadow({ mode: 'open' }),
    Document: () => document, XMLDocument: () => xml, NewDocument: () => new Document(),
    SVGElement: () => document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
    MathMLElement: () => document.createElementNS('http://www.w3.org/1998/Math/MathML', 'math'),
    XMLElement: () => xml.createElementNS(null, 'x'),
    Range: () => new Range(), Event: () => new Event('x'), CustomEvent: () => new CustomEvent('x'),
    MouseEvent: () => new MouseEvent('x'), KeyboardEvent: () => new KeyboardEvent('x'), AbortController: () => new AbortController(),
    NodeList: () => document.querySelectorAll('*'), HTMLCollection: () => document.getElementsByTagName('*'),
    DOMTokenList: () => host.classList, NamedNodeMap: () => host.attributes, CSSStyleDeclaration: () => host.style,
    TreeWalker: () => document.createTreeWalker(document), NodeIterator: () => document.createNodeIterator(document),
    MutationObserver: () => new MutationObserver(() => {}), Selection: () => getSelection(), DOMParser: () => new DOMParser(),
    XMLSerializer: () => new XMLSerializer(), FormData: () => new FormData(), Headers: () => new Headers(),
    URL: () => new URL('http://a/'), URLSearchParams: () => new URLSearchParams(), Blob: () => new Blob([]),
    DOMRect: () => new DOMRect(), XMLHttpRequest: () => new XMLHttpRequest(), Image: () => new Image(), Audio: () => new Audio(),
    Option: () => new Option(), Location: () => location, History: () => history, Navigator: () => navigator, Storage: () => localStorage
  };
  for (const tag of ['a', 'audio', 'body', 'button', 'canvas', 'dialog', 'div', 'form', 'iframe', 'img', 'input', 'label', 'link', 'object',
    'option', 'p', 'script', 'select', 'slot', 'span', 'style', 'table', 'td', 'template', 'textarea', 'tr', 'video', 'x-custom']) {
    instances[`<${tag}>`] = () => document.createElement(tag);
  }
  for (const [name, make] of Object.entries(instances)) {
    let o;
    try { o = make(); } catch (e) { found.add(`${name}: threw ${e.message}`); continue; }
    // (…every attribute of its interfaces read first, so what a member makes lazily — `document.forms`' collection —
    // is there to be seen)
    for (let p = Object.getPrototypeOf(o); p !== null && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(p))) {
        if (typeof d.get === 'function' && !internal(k)) try { d.get.call(o); } catch (_) {}
      }
    }
    for (const k of Reflect.ownKeys(o)) if (internal(k)) found.add(`${name} own ${named(k)}`);
    for (const k in o) if (internal(k)) found.add(`${name} for-in ${k}`);
    let json;
    try { json = JSON.stringify(o); } catch (e) { found.add(`${name} JSON threw ${e.message}`); continue; }
    if (json && json[0] === '{') for (const k of Object.keys(JSON.parse(json))) if (internal(k)) found.add(`${name} JSON ${k}`);
  }
  return [...found].sort();
})()
