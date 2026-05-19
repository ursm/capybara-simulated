// QuickJS's `POLYFILL_INTL` ships getCanonicalLocales / Locale /
// PluralRules / NumberFormat / DateTimeFormat but NOT `Intl.Collator`.
// Mastodon (`components/hashtag_bar.tsx`) constructs one at module
// top-level for ASCII-folded comparison, and the throw propagates
// up the dynamic-import chain as an unhandled module rejection —
// silent under the current quickjs.rb (no rejection tracker). V8
// ships Collator natively; this polyfill only fires on QuickJS.

export function installIfMissing() {
  if (typeof Intl === 'undefined' || typeof Intl.Collator !== 'undefined') return;

  Intl.Collator = function (_locales, options) {
    if (!(this instanceof Intl.Collator)) return new Intl.Collator(_locales, options);
    const sensitivity = (options && options.sensitivity) || 'variant';
    const fold = sensitivity === 'base' || sensitivity === 'accent'
      ? (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      : (s) => String(s);
    this.compare = function (a, b) {
      const fa = fold(a), fb = fold(b);
      return fa < fb ? -1 : fa > fb ? 1 : 0;
    };
    this.resolvedOptions = function () {
      return Object.assign({locale: 'en', usage: 'sort', sensitivity, ignorePunctuation: false,
                            collation: 'default', numeric: false, caseFirst: 'false'}, options || {});
    };
  };
  Intl.Collator.supportedLocalesOf = function (locales) {
    return Array.isArray(locales) ? locales.slice() : (locales ? [locales] : []);
  };
}
