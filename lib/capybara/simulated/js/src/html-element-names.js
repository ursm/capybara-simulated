// The HTML element-interface map, as a single source of truth: every tag name
// that maps to a dedicated interface (HTMLDivElement, …) OR to the base
// HTMLElement interface for obsolete-but-conforming names (`abbr`, `center`, …).
// A tag ABSENT here maps to HTMLUnknownElement — both for `instanceof`
// narrowing (dom-class-aliases.js) and for `customElements.define`'s `extends`
// validation (custom-elements.js), which rejects a name whose interface is
// HTMLUnknownElement. Keeping the two consumers on one set is what keeps
// "is `<bgsound>` an HTMLElement?" and "can I `extends: 'bgsound'`?" answering
// the same way.
//
// The obsolete elements `bgsound` / `isindex` / `keygen` / `multicol` /
// `nextid` / `spacer` / `blink` map to HTMLUnknownElement per the HTML spec's
// obsolete-elements table, so they are deliberately NOT listed here.
export const KNOWN_HTML_TAGS = new Set([
  'a','abbr','acronym','address','area','article','aside','audio','b','base',
  'bdi','bdo','big','blockquote','body','br','button','canvas',
  'caption','center','cite','code','col','colgroup','data','datalist','dd',
  'del','details','dfn','dialog','dir','div','dl','dt','em','embed','fieldset',
  'figcaption','figure','font','footer','form','frame','frameset','h1','h2',
  'h3','h4','h5','h6','head','header','hgroup','hr','html','i','iframe','img',
  'input','ins','kbd','label','legend','li','link','main','map',
  'mark','marquee','menu','meta','meter','nav','nobr','noembed','noframes',
  'noscript','object','ol','optgroup','option','output','p','param','picture',
  'plaintext','pre','progress','q','rp','rt','ruby','s','samp','script',
  'section','select','slot','small','source','span','strike','strong',
  'style','sub','summary','sup','table','tbody','td','template','textarea',
  'tfoot','th','thead','time','title','tr','track','tt','u','ul','var','video',
  'wbr','xmp'
]);

// Does `name` map to an interface OTHER than HTMLUnknownElement? (The element
// interface for `name` and the HTML namespace is not HTMLUnknownElement.)
export function isKnownHtmlElementName(name) {
  return KNOWN_HTML_TAGS.has(name);
}
