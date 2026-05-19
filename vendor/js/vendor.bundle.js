var __csimVendor = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // vendor/src/vendor.entry.js
  var vendor_entry_exports = {};
  __export(vendor_entry_exports, {
    cssSelect: () => dist_exports5,
    cssWhat: () => dist_exports
  });

  // node_modules/.pnpm/css-select@7.0.0/node_modules/css-select/dist/index.js
  var dist_exports5 = {};
  __export(dist_exports5, {
    _compileUnsafe: () => _compileUnsafe,
    compile: () => compile2,
    default: () => dist_default2,
    is: () => is2,
    prepareContext: () => prepareContext,
    selectAll: () => selectAll,
    selectOne: () => selectOne
  });

  // node_modules/.pnpm/boolbase@2.0.0/node_modules/boolbase/dist/index.js
  function trueFunc() {
    return true;
  }
  function falseFunc() {
    return false;
  }

  // node_modules/.pnpm/css-what@8.0.0/node_modules/css-what/dist/index.js
  var dist_exports = {};
  __export(dist_exports, {
    AttributeAction: () => AttributeAction,
    IgnoreCaseMode: () => IgnoreCaseMode,
    SelectorType: () => SelectorType,
    isTraversal: () => isTraversal,
    parse: () => parse,
    stringify: () => stringify
  });

  // node_modules/.pnpm/css-what@8.0.0/node_modules/css-what/dist/types.js
  var SelectorType;
  (function(SelectorType2) {
    SelectorType2["Attribute"] = "attribute";
    SelectorType2["Pseudo"] = "pseudo";
    SelectorType2["PseudoElement"] = "pseudo-element";
    SelectorType2["Tag"] = "tag";
    SelectorType2["Universal"] = "universal";
    SelectorType2["Adjacent"] = "adjacent";
    SelectorType2["Child"] = "child";
    SelectorType2["Descendant"] = "descendant";
    SelectorType2["Parent"] = "parent";
    SelectorType2["Sibling"] = "sibling";
    SelectorType2["ColumnCombinator"] = "column-combinator";
  })(SelectorType || (SelectorType = {}));
  var IgnoreCaseMode = {
    Unknown: null,
    QuirksMode: "quirks",
    IgnoreCase: true,
    CaseSensitive: false
  };
  var AttributeAction;
  (function(AttributeAction2) {
    AttributeAction2["Any"] = "any";
    AttributeAction2["Element"] = "element";
    AttributeAction2["End"] = "end";
    AttributeAction2["Equals"] = "equals";
    AttributeAction2["Exists"] = "exists";
    AttributeAction2["Hyphen"] = "hyphen";
    AttributeAction2["Not"] = "not";
    AttributeAction2["Start"] = "start";
  })(AttributeAction || (AttributeAction = {}));

  // node_modules/.pnpm/css-what@8.0.0/node_modules/css-what/dist/parse.js
  var reName = /^[^#\\]?(?:\\(?:[\da-f]{1,6}\s?|.)|[\w\u00B0-\uFFFF-])+/;
  var reEscape = /\\([\da-f]{1,6}\s?|(\s)|.)/gi;
  var CharCode;
  (function(CharCode2) {
    CharCode2[CharCode2["LeftParenthesis"] = 40] = "LeftParenthesis";
    CharCode2[CharCode2["RightParenthesis"] = 41] = "RightParenthesis";
    CharCode2[CharCode2["LeftSquareBracket"] = 91] = "LeftSquareBracket";
    CharCode2[CharCode2["RightSquareBracket"] = 93] = "RightSquareBracket";
    CharCode2[CharCode2["Comma"] = 44] = "Comma";
    CharCode2[CharCode2["Period"] = 46] = "Period";
    CharCode2[CharCode2["Colon"] = 58] = "Colon";
    CharCode2[CharCode2["SingleQuote"] = 39] = "SingleQuote";
    CharCode2[CharCode2["DoubleQuote"] = 34] = "DoubleQuote";
    CharCode2[CharCode2["Plus"] = 43] = "Plus";
    CharCode2[CharCode2["Tilde"] = 126] = "Tilde";
    CharCode2[CharCode2["QuestionMark"] = 63] = "QuestionMark";
    CharCode2[CharCode2["ExclamationMark"] = 33] = "ExclamationMark";
    CharCode2[CharCode2["Slash"] = 47] = "Slash";
    CharCode2[CharCode2["Equal"] = 61] = "Equal";
    CharCode2[CharCode2["Dollar"] = 36] = "Dollar";
    CharCode2[CharCode2["Pipe"] = 124] = "Pipe";
    CharCode2[CharCode2["Circumflex"] = 94] = "Circumflex";
    CharCode2[CharCode2["Asterisk"] = 42] = "Asterisk";
    CharCode2[CharCode2["GreaterThan"] = 62] = "GreaterThan";
    CharCode2[CharCode2["LessThan"] = 60] = "LessThan";
    CharCode2[CharCode2["Hash"] = 35] = "Hash";
    CharCode2[CharCode2["LowerI"] = 105] = "LowerI";
    CharCode2[CharCode2["LowerS"] = 115] = "LowerS";
    CharCode2[CharCode2["BackSlash"] = 92] = "BackSlash";
    CharCode2[CharCode2["Space"] = 32] = "Space";
    CharCode2[CharCode2["Tab"] = 9] = "Tab";
    CharCode2[CharCode2["NewLine"] = 10] = "NewLine";
    CharCode2[CharCode2["FormFeed"] = 12] = "FormFeed";
    CharCode2[CharCode2["CarriageReturn"] = 13] = "CarriageReturn";
  })(CharCode || (CharCode = {}));
  var actionTypes = /* @__PURE__ */ new Map([
    [CharCode.Tilde, AttributeAction.Element],
    [CharCode.Circumflex, AttributeAction.Start],
    [CharCode.Dollar, AttributeAction.End],
    [CharCode.Asterisk, AttributeAction.Any],
    [CharCode.ExclamationMark, AttributeAction.Not],
    [CharCode.Pipe, AttributeAction.Hyphen]
  ]);
  var unpackPseudos = /* @__PURE__ */ new Set([
    "has",
    "not",
    "matches",
    "is",
    "where",
    "host",
    "host-context"
  ]);
  var pseudosToPseudoElements = /* @__PURE__ */ new Set([
    "before",
    "after",
    "first-line",
    "first-letter"
  ]);
  function isTraversal(selector) {
    switch (selector.type) {
      case SelectorType.Adjacent:
      case SelectorType.Child:
      case SelectorType.Descendant:
      case SelectorType.Parent:
      case SelectorType.Sibling:
      case SelectorType.ColumnCombinator: {
        return true;
      }
      case SelectorType.Attribute:
      case SelectorType.Pseudo:
      case SelectorType.PseudoElement:
      case SelectorType.Tag:
      case SelectorType.Universal: {
        return false;
      }
    }
  }
  var stripQuotesFromPseudos = /* @__PURE__ */ new Set(["contains", "icontains"]);
  function funescape(_, escaped, escapedWhitespace) {
    const high = Number.parseInt(escaped, 16) - 65536;
    return Number.isNaN(high) || escapedWhitespace ? escaped : high < 0 ? (
      // BMP codepoint
      String.fromCharCode(high + 65536)
    ) : (
      // Supplemental Plane codepoint (surrogate pair)
      String.fromCharCode(high >> 10 | 55296, high & 1023 | 56320)
    );
  }
  function unescapeCSS(cssString) {
    return cssString.replace(reEscape, funescape);
  }
  function isQuote(c) {
    return c === CharCode.SingleQuote || c === CharCode.DoubleQuote;
  }
  function isWhitespace(c) {
    return c === CharCode.Space || c === CharCode.Tab || c === CharCode.NewLine || c === CharCode.FormFeed || c === CharCode.CarriageReturn;
  }
  function parse(selector) {
    const subselects2 = [];
    const endIndex = parseSelector(subselects2, `${selector}`, 0);
    if (endIndex < selector.length) {
      throw new Error(`Unmatched selector: ${selector.slice(endIndex)}`);
    }
    return subselects2;
  }
  function parseSelector(subselects2, selector, selectorIndex) {
    let tokens = [];
    function getName2(offset) {
      const match = selector.slice(selectorIndex + offset).match(reName);
      if (!match) {
        throw new Error(`Expected name, found ${selector.slice(selectorIndex)}`);
      }
      const [name] = match;
      selectorIndex += offset + name.length;
      return unescapeCSS(name);
    }
    function stripWhitespace(offset) {
      selectorIndex += offset;
      while (selectorIndex < selector.length && isWhitespace(selector.charCodeAt(selectorIndex))) {
        selectorIndex++;
      }
    }
    function readValueWithParenthesis() {
      selectorIndex += 1;
      const start = selectorIndex;
      for (let counter = 1; selectorIndex < selector.length; selectorIndex++) {
        switch (selector.charCodeAt(selectorIndex)) {
          case CharCode.BackSlash: {
            selectorIndex += 1;
            break;
          }
          case CharCode.LeftParenthesis: {
            counter += 1;
            break;
          }
          case CharCode.RightParenthesis: {
            counter -= 1;
            if (counter === 0) {
              return unescapeCSS(selector.slice(start, selectorIndex++));
            }
            break;
          }
        }
      }
      throw new Error("Parenthesis not matched");
    }
    function ensureNotTraversal() {
      if (tokens.length > 0 && isTraversal(tokens[tokens.length - 1])) {
        throw new Error("Did not expect successive traversals.");
      }
    }
    function addTraversal(type) {
      if (tokens.length > 0 && tokens[tokens.length - 1].type === SelectorType.Descendant) {
        tokens[tokens.length - 1].type = type;
        return;
      }
      ensureNotTraversal();
      tokens.push({ type });
    }
    function addSpecialAttribute(name, action) {
      tokens.push({
        type: SelectorType.Attribute,
        name,
        action,
        value: getName2(1),
        namespace: null,
        ignoreCase: "quirks"
      });
    }
    function finalizeSubselector() {
      if (tokens.length > 0 && tokens[tokens.length - 1].type === SelectorType.Descendant) {
        tokens.pop();
      }
      if (tokens.length === 0) {
        throw new Error("Empty sub-selector");
      }
      subselects2.push(tokens);
    }
    stripWhitespace(0);
    if (selector.length === selectorIndex) {
      return selectorIndex;
    }
    loop: while (selectorIndex < selector.length) {
      const firstChar = selector.charCodeAt(selectorIndex);
      switch (firstChar) {
        // Whitespace
        case CharCode.Space:
        case CharCode.Tab:
        case CharCode.NewLine:
        case CharCode.FormFeed:
        case CharCode.CarriageReturn: {
          if (tokens.length === 0 || tokens[0].type !== SelectorType.Descendant) {
            ensureNotTraversal();
            tokens.push({ type: SelectorType.Descendant });
          }
          stripWhitespace(1);
          break;
        }
        // Traversals
        case CharCode.GreaterThan: {
          addTraversal(SelectorType.Child);
          stripWhitespace(1);
          break;
        }
        case CharCode.LessThan: {
          addTraversal(SelectorType.Parent);
          stripWhitespace(1);
          break;
        }
        case CharCode.Tilde: {
          addTraversal(SelectorType.Sibling);
          stripWhitespace(1);
          break;
        }
        case CharCode.Plus: {
          addTraversal(SelectorType.Adjacent);
          stripWhitespace(1);
          break;
        }
        // Special attribute selectors: .class, #id
        case CharCode.Period: {
          addSpecialAttribute("class", AttributeAction.Element);
          break;
        }
        case CharCode.Hash: {
          addSpecialAttribute("id", AttributeAction.Equals);
          break;
        }
        case CharCode.LeftSquareBracket: {
          stripWhitespace(1);
          let name;
          let namespace = null;
          if (selector.charCodeAt(selectorIndex) === CharCode.Pipe) {
            name = getName2(1);
          } else if (selector.startsWith("*|", selectorIndex)) {
            namespace = "*";
            name = getName2(2);
          } else {
            name = getName2(0);
            if (selector.charCodeAt(selectorIndex) === CharCode.Pipe && selector.charCodeAt(selectorIndex + 1) !== CharCode.Equal) {
              namespace = name;
              name = getName2(1);
            }
          }
          stripWhitespace(0);
          let action = AttributeAction.Exists;
          const possibleAction = actionTypes.get(selector.charCodeAt(selectorIndex));
          if (possibleAction) {
            action = possibleAction;
            if (selector.charCodeAt(selectorIndex + 1) !== CharCode.Equal) {
              throw new Error("Expected `=`");
            }
            stripWhitespace(2);
          } else if (selector.charCodeAt(selectorIndex) === CharCode.Equal) {
            action = AttributeAction.Equals;
            stripWhitespace(1);
          }
          let value = "";
          let ignoreCase = null;
          if (action !== "exists") {
            if (isQuote(selector.charCodeAt(selectorIndex))) {
              const quote = selector.charCodeAt(selectorIndex);
              selectorIndex += 1;
              const sectionStart = selectorIndex;
              while (selectorIndex < selector.length && selector.charCodeAt(selectorIndex) !== quote) {
                selectorIndex += // Skip next character if it is escaped
                selector.charCodeAt(selectorIndex) === CharCode.BackSlash ? 2 : 1;
              }
              if (selector.charCodeAt(selectorIndex) !== quote) {
                throw new Error("Attribute value didn't end");
              }
              value = unescapeCSS(selector.slice(sectionStart, selectorIndex));
              selectorIndex += 1;
            } else {
              const valueStart = selectorIndex;
              while (selectorIndex < selector.length && !isWhitespace(selector.charCodeAt(selectorIndex)) && selector.charCodeAt(selectorIndex) !== CharCode.RightSquareBracket) {
                selectorIndex += // Skip next character if it is escaped
                selector.charCodeAt(selectorIndex) === CharCode.BackSlash ? 2 : 1;
              }
              value = unescapeCSS(selector.slice(valueStart, selectorIndex));
            }
            stripWhitespace(0);
            switch (selector.charCodeAt(selectorIndex) | 32) {
              // If the forceIgnore flag is set (either `i` or `s`), use that value
              case CharCode.LowerI: {
                ignoreCase = true;
                stripWhitespace(1);
                break;
              }
              case CharCode.LowerS: {
                ignoreCase = false;
                stripWhitespace(1);
                break;
              }
            }
          }
          if (selector.charCodeAt(selectorIndex) !== CharCode.RightSquareBracket) {
            throw new Error("Attribute selector didn't terminate");
          }
          selectorIndex += 1;
          const attributeSelector = {
            type: SelectorType.Attribute,
            name,
            action,
            value,
            namespace,
            ignoreCase
          };
          tokens.push(attributeSelector);
          break;
        }
        case CharCode.Colon: {
          if (selector.charCodeAt(selectorIndex + 1) === CharCode.Colon) {
            tokens.push({
              type: SelectorType.PseudoElement,
              name: getName2(2).toLowerCase(),
              data: selector.charCodeAt(selectorIndex) === CharCode.LeftParenthesis ? readValueWithParenthesis() : null
            });
            break;
          }
          const name = getName2(1).toLowerCase();
          if (pseudosToPseudoElements.has(name)) {
            tokens.push({
              type: SelectorType.PseudoElement,
              name,
              data: null
            });
            break;
          }
          let data = null;
          if (selector.charCodeAt(selectorIndex) === CharCode.LeftParenthesis) {
            if (unpackPseudos.has(name)) {
              if (isQuote(selector.charCodeAt(selectorIndex + 1))) {
                throw new Error(`Pseudo-selector ${name} cannot be quoted`);
              }
              data = [];
              selectorIndex = parseSelector(data, selector, selectorIndex + 1);
              if (selector.charCodeAt(selectorIndex) !== CharCode.RightParenthesis) {
                throw new Error(`Missing closing parenthesis in :${name} (${selector})`);
              }
              selectorIndex += 1;
            } else {
              data = readValueWithParenthesis();
              if (stripQuotesFromPseudos.has(name)) {
                const quot = data.charCodeAt(0);
                if (quot === data.charCodeAt(data.length - 1) && isQuote(quot)) {
                  data = data.slice(1, -1);
                }
              }
              data = unescapeCSS(data);
            }
          }
          tokens.push({ type: SelectorType.Pseudo, name, data });
          break;
        }
        case CharCode.Comma: {
          finalizeSubselector();
          tokens = [];
          stripWhitespace(1);
          break;
        }
        default: {
          if (selector.startsWith("/*", selectorIndex)) {
            const endIndex = selector.indexOf("*/", selectorIndex + 2);
            if (endIndex === -1) {
              throw new Error("Comment was not terminated");
            }
            selectorIndex = endIndex + 2;
            if (tokens.length === 0) {
              stripWhitespace(0);
            }
            break;
          }
          let namespace = null;
          let name;
          if (firstChar === CharCode.Asterisk) {
            selectorIndex += 1;
            name = "*";
          } else if (firstChar === CharCode.Pipe) {
            name = "";
            if (selector.charCodeAt(selectorIndex + 1) === CharCode.Pipe) {
              addTraversal(SelectorType.ColumnCombinator);
              stripWhitespace(2);
              break;
            }
          } else if (reName.test(selector.slice(selectorIndex))) {
            name = getName2(0);
          } else {
            break loop;
          }
          if (selector.charCodeAt(selectorIndex) === CharCode.Pipe && selector.charCodeAt(selectorIndex + 1) !== CharCode.Pipe) {
            namespace = name;
            if (selector.charCodeAt(selectorIndex + 1) === CharCode.Asterisk) {
              name = "*";
              selectorIndex += 2;
            } else {
              name = getName2(1);
            }
          }
          tokens.push(name === "*" ? { type: SelectorType.Universal, namespace } : { type: SelectorType.Tag, name, namespace });
        }
      }
    }
    finalizeSubselector();
    return selectorIndex;
  }

  // node_modules/.pnpm/css-what@8.0.0/node_modules/css-what/dist/stringify.js
  var attribValueChars = ["\\", '"'];
  var pseudoValueChars = [...attribValueChars, "(", ")"];
  var charsToEscapeInAttributeValue = new Set(attribValueChars.map((c) => c.charCodeAt(0)));
  var charsToEscapeInPseudoValue = new Set(pseudoValueChars.map((c) => c.charCodeAt(0)));
  var charsToEscapeInName = new Set([
    ...pseudoValueChars,
    "~",
    "^",
    "$",
    "*",
    "+",
    "!",
    "|",
    ":",
    "[",
    "]",
    " ",
    ".",
    "%"
  ].map((c) => c.charCodeAt(0)));
  function stringify(selector) {
    return selector.map((token) => token.map((token2, index, array) => stringifyToken(token2, index, array)).join("")).join(", ");
  }
  function stringifyToken(token, index, array) {
    switch (token.type) {
      // Simple types
      case SelectorType.Child: {
        return index === 0 ? "> " : " > ";
      }
      case SelectorType.Parent: {
        return index === 0 ? "< " : " < ";
      }
      case SelectorType.Sibling: {
        return index === 0 ? "~ " : " ~ ";
      }
      case SelectorType.Adjacent: {
        return index === 0 ? "+ " : " + ";
      }
      case SelectorType.Descendant: {
        return " ";
      }
      case SelectorType.ColumnCombinator: {
        return index === 0 ? "|| " : " || ";
      }
      case SelectorType.Universal: {
        return token.namespace === "*" && index + 1 < array.length && "name" in array[index + 1] ? "" : `${getNamespace(token.namespace)}*`;
      }
      case SelectorType.Tag: {
        return getNamespacedName(token);
      }
      case SelectorType.PseudoElement: {
        return `::${escapeName(token.name, charsToEscapeInName)}${token.data === null ? "" : `(${escapeName(token.data, charsToEscapeInPseudoValue)})`}`;
      }
      case SelectorType.Pseudo: {
        return `:${escapeName(token.name, charsToEscapeInName)}${token.data === null ? "" : `(${typeof token.data === "string" ? escapeName(token.data, charsToEscapeInPseudoValue) : stringify(token.data)})`}`;
      }
      case SelectorType.Attribute: {
        if (token.name === "id" && token.action === AttributeAction.Equals && token.ignoreCase === "quirks" && !token.namespace) {
          return `#${escapeName(token.value, charsToEscapeInName)}`;
        }
        if (token.name === "class" && token.action === AttributeAction.Element && token.ignoreCase === "quirks" && !token.namespace) {
          return `.${escapeName(token.value, charsToEscapeInName)}`;
        }
        const name = getNamespacedName(token);
        if (token.action === AttributeAction.Exists) {
          return `[${name}]`;
        }
        return `[${name}${getActionValue(token.action)}="${escapeName(token.value, charsToEscapeInAttributeValue)}"${token.ignoreCase === null ? "" : token.ignoreCase ? " i" : " s"}]`;
      }
    }
  }
  function getActionValue(action) {
    switch (action) {
      case AttributeAction.Equals: {
        return "";
      }
      case AttributeAction.Element: {
        return "~";
      }
      case AttributeAction.Start: {
        return "^";
      }
      case AttributeAction.End: {
        return "$";
      }
      case AttributeAction.Any: {
        return "*";
      }
      case AttributeAction.Not: {
        return "!";
      }
      case AttributeAction.Hyphen: {
        return "|";
      }
      default: {
        throw new Error("Shouldn't be here");
      }
    }
  }
  function getNamespacedName(token) {
    return `${getNamespace(token.namespace)}${escapeName(token.name, charsToEscapeInName)}`;
  }
  function getNamespace(namespace) {
    return namespace === null ? "" : `${namespace === "*" ? "*" : escapeName(namespace, charsToEscapeInName)}|`;
  }
  function escapeName(name, charsToEscape) {
    let lastIndex = 0;
    let escapedName = "";
    for (let index = 0; index < name.length; index++) {
      if (charsToEscape.has(name.charCodeAt(index))) {
        escapedName += `${name.slice(lastIndex, index)}\\${name.charAt(index)}`;
        lastIndex = index + 1;
      }
    }
    return escapedName.length > 0 ? escapedName + name.slice(lastIndex) : name;
  }

  // node_modules/.pnpm/domelementtype@3.0.0/node_modules/domelementtype/dist/index.js
  var ElementType;
  (function(ElementType2) {
    ElementType2["Root"] = "root";
    ElementType2["Text"] = "text";
    ElementType2["Directive"] = "directive";
    ElementType2["Comment"] = "comment";
    ElementType2["Script"] = "script";
    ElementType2["Style"] = "style";
    ElementType2["Tag"] = "tag";
    ElementType2["CDATA"] = "cdata";
    ElementType2["Doctype"] = "doctype";
  })(ElementType || (ElementType = {}));
  function isTag(element) {
    return element.type === ElementType.Tag || element.type === ElementType.Script || element.type === ElementType.Style;
  }
  var Root = ElementType.Root;
  var Text = ElementType.Text;
  var Directive = ElementType.Directive;
  var Comment = ElementType.Comment;
  var Script = ElementType.Script;
  var Style = ElementType.Style;
  var Tag = ElementType.Tag;
  var CDATA = ElementType.CDATA;
  var Doctype = ElementType.Doctype;

  // node_modules/.pnpm/domhandler@6.0.1/node_modules/domhandler/dist/node.js
  function isTag2(node) {
    return isTag(node);
  }
  function isCDATA(node) {
    return node.type === ElementType.CDATA;
  }
  function isText(node) {
    return node.type === ElementType.Text;
  }
  function isComment(node) {
    return node.type === ElementType.Comment;
  }
  function hasChildren(node) {
    return Object.hasOwn(node, "children");
  }

  // node_modules/.pnpm/domutils@4.0.2/node_modules/domutils/dist/index.js
  var dist_exports3 = {};
  __export(dist_exports3, {
    DocumentPosition: () => DocumentPosition,
    append: () => append,
    appendChild: () => appendChild,
    compareDocumentPosition: () => compareDocumentPosition,
    existsOne: () => existsOne,
    filter: () => filter,
    find: () => find,
    findAll: () => findAll,
    findOne: () => findOne,
    getAttributeValue: () => getAttributeValue,
    getChildren: () => getChildren,
    getElementById: () => getElementById,
    getElements: () => getElements,
    getElementsByClassName: () => getElementsByClassName,
    getElementsByTagName: () => getElementsByTagName,
    getElementsByTagType: () => getElementsByTagType,
    getFeed: () => getFeed,
    getInnerHTML: () => getInnerHTML,
    getName: () => getName,
    getOuterHTML: () => getOuterHTML,
    getParent: () => getParent,
    getSiblings: () => getSiblings,
    getText: () => getText,
    hasAttrib: () => hasAttrib,
    innerText: () => innerText,
    nextElementSibling: () => nextElementSibling,
    prepend: () => prepend,
    prependChild: () => prependChild,
    prevElementSibling: () => prevElementSibling,
    removeElement: () => removeElement,
    removeSubsets: () => removeSubsets,
    replaceElement: () => replaceElement,
    testElement: () => testElement,
    textContent: () => textContent,
    uniqueSort: () => uniqueSort
  });

  // node_modules/.pnpm/domutils@4.0.2/node_modules/domutils/dist/querying.js
  function filter(test, node, recurse = true, limit = Number.POSITIVE_INFINITY) {
    return find(test, Array.isArray(node) ? node : [node], recurse, limit);
  }
  function find(test, nodes, recurse, limit) {
    const result = [];
    const nodeStack = [Array.isArray(nodes) ? nodes : [nodes]];
    const indexStack = [0];
    for (; ; ) {
      if (indexStack[0] >= nodeStack[0].length) {
        if (indexStack.length === 1) {
          return result;
        }
        nodeStack.shift();
        indexStack.shift();
        continue;
      }
      const element = nodeStack[0][indexStack[0]++];
      if (test(element)) {
        result.push(element);
        if (--limit <= 0)
          return result;
      }
      if (recurse && hasChildren(element) && element.children.length > 0) {
        indexStack.unshift(0);
        nodeStack.unshift(element.children);
      }
    }
  }
  function findOne(test, nodes, recurse = true) {
    const searchedNodes = Array.isArray(nodes) ? nodes : [nodes];
    for (const node of searchedNodes) {
      if (isTag2(node) && test(node)) {
        return node;
      }
      if (recurse && hasChildren(node) && node.children.length > 0) {
        const found = findOne(test, node.children, true);
        if (found)
          return found;
      }
    }
    return null;
  }
  function existsOne(test, nodes) {
    return (Array.isArray(nodes) ? nodes : [nodes]).some((node) => isTag2(node) && test(node) || hasChildren(node) && existsOne(test, node.children));
  }
  function findAll(test, nodes) {
    const result = [];
    const nodeStack = [Array.isArray(nodes) ? nodes : [nodes]];
    const indexStack = [0];
    for (; ; ) {
      if (indexStack[0] >= nodeStack[0].length) {
        if (nodeStack.length === 1) {
          return result;
        }
        nodeStack.shift();
        indexStack.shift();
        continue;
      }
      const element = nodeStack[0][indexStack[0]++];
      if (isTag2(element) && test(element))
        result.push(element);
      if (hasChildren(element) && element.children.length > 0) {
        indexStack.unshift(0);
        nodeStack.unshift(element.children);
      }
    }
  }

  // node_modules/.pnpm/domutils@4.0.2/node_modules/domutils/dist/legacy.js
  var Checks = {
    tag_name(name) {
      if (typeof name === "function") {
        return (element) => isTag2(element) && name(element.name);
      }
      if (name === "*") {
        return isTag2;
      }
      return (element) => isTag2(element) && element.name === name;
    },
    tag_type(type) {
      if (typeof type === "function") {
        return (element) => type(element.type);
      }
      return (element) => element.type === type;
    },
    tag_contains(data) {
      if (typeof data === "function") {
        return (element) => isText(element) && data(element.data);
      }
      return (element) => isText(element) && element.data === data;
    }
  };
  function getAttribCheck(attrib, value) {
    if (typeof value === "function") {
      return (element) => isTag2(element) && value(element.attribs[attrib]);
    }
    return (element) => isTag2(element) && element.attribs[attrib] === value;
  }
  function combineFuncs(a, b) {
    return (element) => a(element) || b(element);
  }
  function compileTest(options) {
    const funcs = Object.keys(options).map((key) => {
      const value = options[key];
      return Object.hasOwn(Checks, key) ? Checks[key](value) : getAttribCheck(key, value);
    });
    return funcs.length === 0 ? null : funcs.reduce(combineFuncs);
  }
  function testElement(options, node) {
    const test = compileTest(options);
    return test ? test(node) : true;
  }
  function getElements(options, nodes, recurse, limit = Number.POSITIVE_INFINITY) {
    const test = compileTest(options);
    return test ? filter(test, nodes, recurse, limit) : [];
  }
  function getElementById(id, nodes, recurse = true) {
    if (!Array.isArray(nodes))
      nodes = [nodes];
    return findOne(getAttribCheck("id", id), nodes, recurse);
  }
  function getElementsByTagName(tagName, nodes, recurse = true, limit = Number.POSITIVE_INFINITY) {
    return filter(Checks["tag_name"](tagName), nodes, recurse, limit);
  }
  function getElementsByClassName(className, nodes, recurse = true, limit = Number.POSITIVE_INFINITY) {
    return filter(getAttribCheck("class", className), nodes, recurse, limit);
  }
  function getElementsByTagType(type, nodes, recurse = true, limit = Number.POSITIVE_INFINITY) {
    return filter(Checks["tag_type"](type), nodes, recurse, limit);
  }

  // node_modules/.pnpm/entities@8.0.0/node_modules/entities/dist/escape.js
  var xmlCodeMap = /* @__PURE__ */ new Map([
    [34, "&quot;"],
    [38, "&amp;"],
    [39, "&apos;"],
    [60, "&lt;"],
    [62, "&gt;"]
  ]);
  var getCodePoint = typeof String.prototype.codePointAt === "function" ? (input, index) => input.codePointAt(index) : (
    // http://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
    (c, index) => (c.charCodeAt(index) & 64512) === 55296 ? (c.charCodeAt(index) - 55296) * 1024 + c.charCodeAt(index + 1) - 56320 + 65536 : c.charCodeAt(index)
  );
  var XML_BITSET_VALUE = 1342177476;
  function encodeXML(input) {
    let out;
    let last = 0;
    const { length } = input;
    for (let index = 0; index < length; index++) {
      const char = input.charCodeAt(index);
      if (char < 128 && ((XML_BITSET_VALUE >>> char & 1) === 0 || char >= 64 || char < 32)) {
        continue;
      }
      if (out === void 0)
        out = input.substring(0, index);
      else if (last !== index)
        out += input.substring(last, index);
      if (char < 64) {
        out += xmlCodeMap.get(char);
        last = index + 1;
        continue;
      }
      const cp = getCodePoint(input, index);
      out += `&#x${cp.toString(16)};`;
      if (cp !== char)
        index++;
      last = index + 1;
    }
    if (out === void 0)
      return input;
    if (last < length)
      out += input.substr(last);
    return out;
  }
  function getEscaper(regex, map) {
    return function escape2(data) {
      let match;
      let lastIndex = 0;
      let result = "";
      while (match = regex.exec(data)) {
        if (lastIndex !== match.index) {
          result += data.substring(lastIndex, match.index);
        }
        result += map.get(match[0].charCodeAt(0));
        lastIndex = match.index + 1;
      }
      return result + data.substring(lastIndex);
    };
  }
  var escapeAttribute = /* @__PURE__ */ getEscaper(/["&\u00A0]/g, /* @__PURE__ */ new Map([
    [34, "&quot;"],
    [38, "&amp;"],
    [160, "&nbsp;"]
  ]));
  var escapeText = /* @__PURE__ */ getEscaper(/[&<>\u00A0]/g, /* @__PURE__ */ new Map([
    [38, "&amp;"],
    [60, "&lt;"],
    [62, "&gt;"],
    [160, "&nbsp;"]
  ]));

  // node_modules/.pnpm/entities@8.0.0/node_modules/entities/dist/index.js
  var EntityLevel;
  (function(EntityLevel2) {
    EntityLevel2[EntityLevel2["XML"] = 0] = "XML";
    EntityLevel2[EntityLevel2["HTML"] = 1] = "HTML";
  })(EntityLevel || (EntityLevel = {}));
  var EncodingMode;
  (function(EncodingMode2) {
    EncodingMode2[EncodingMode2["UTF8"] = 0] = "UTF8";
    EncodingMode2[EncodingMode2["ASCII"] = 1] = "ASCII";
    EncodingMode2[EncodingMode2["Extensive"] = 2] = "Extensive";
    EncodingMode2[EncodingMode2["Attribute"] = 3] = "Attribute";
    EncodingMode2[EncodingMode2["Text"] = 4] = "Text";
  })(EncodingMode || (EncodingMode = {}));

  // node_modules/.pnpm/dom-serializer@3.1.1/node_modules/dom-serializer/dist/foreign-names.js
  var elementNames = new Map("altGlyph altGlyphDef altGlyphItem animateColor animateMotion animateTransform clipPath feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence foreignObject glyphRef linearGradient radialGradient textPath".split(" ").map((name) => [name.toLowerCase(), name]));
  var attributeNames = new Map("definitionURL attributeName attributeType baseFrequency baseProfile calcMode clipPathUnits diffuseConstant edgeMode filterUnits glyphRef gradientTransform gradientUnits kernelMatrix kernelUnitLength keyPoints keySplines keyTimes lengthAdjust limitingConeAngle markerHeight markerUnits markerWidth maskContentUnits maskUnits numOctaves pathLength patternContentUnits patternTransform patternUnits pointsAtX pointsAtY pointsAtZ preserveAlpha preserveAspectRatio primitiveUnits refX refY repeatCount repeatDur requiredExtensions requiredFeatures specularConstant specularExponent spreadMethod startOffset stdDeviation stitchTiles surfaceScale systemLanguage tableValues targetX targetY textLength viewBox viewTarget xChannelSelector yChannelSelector zoomAndPan".split(" ").map((name) => [name.toLowerCase(), name]));

  // node_modules/.pnpm/dom-serializer@3.1.1/node_modules/dom-serializer/dist/index.js
  var unencodedElements = new Set("style script xmp iframe noembed noframes plaintext noscript".split(" "));
  var voidElements = new Set("area base basefont br col command embed frame hr img input isindex keygen link meta param source track wbr".split(" "));
  var foreignElements = /* @__PURE__ */ new Set(["svg", "math"]);
  var foreignModeIntegrationPoints = new Set("mi mo mn ms mtext annotation-xml foreignObject desc title".split(" "));
  function render(node, options = {}) {
    const nodes = "length" in node ? node : [node];
    const xmlMode = options.xmlMode ?? false;
    let output = "";
    for (let index = 0; index < nodes.length; index++) {
      output += renderNode(nodes[index], options, xmlMode);
    }
    return output;
  }
  var dist_default = render;
  function renderChildren(children, options, xmlMode) {
    let output = "";
    for (let index = 0; index < children.length; index++) {
      output += renderNode(children[index], options, xmlMode);
    }
    return output;
  }
  function renderNode(node, options, xmlMode) {
    switch (node.type) {
      case Root: {
        return renderChildren(node.children, options, xmlMode);
      }
      case Directive: {
        return `<${node.data}>`;
      }
      case Comment: {
        return `<!--${node.data}-->`;
      }
      case CDATA: {
        return `<![CDATA[${node.children[0].data}]]>`;
      }
      case Script:
      case Style:
      case Tag: {
        return renderTag(node, options, xmlMode);
      }
      case Text: {
        const element = node;
        const data = element.data || "";
        if ((options.encodeEntities ?? options.decodeEntities) !== false && !(!xmlMode && element.parent && unencodedElements.has(element.parent.name))) {
          return xmlMode || options.encodeEntities !== "utf8" ? encodeXML(data) : escapeText(data);
        }
        return data;
      }
    }
  }
  function renderTag(element, options, xmlMode) {
    if (xmlMode === "foreign") {
      element.name = elementNames.get(element.name) ?? element.name;
      if (element.parent && foreignModeIntegrationPoints.has(element.parent.name)) {
        xmlMode = false;
      }
    }
    if (!xmlMode && foreignElements.has(element.name)) {
      xmlMode = "foreign";
    }
    const { name, children } = element;
    const isVoid = !xmlMode && voidElements.has(name);
    let tag = `<${name}${formatAttributes(element.attribs, options, xmlMode)}`;
    if (children.length === 0 && (xmlMode ? options.selfClosingTags !== false : options.selfClosingTags && isVoid)) {
      tag += xmlMode ? "/>" : " />";
    } else {
      tag += ">";
      if (children.length > 0) {
        tag += renderChildren(children, options, xmlMode);
      }
      if (!isVoid) {
        tag += `</${name}>`;
      }
    }
    return tag;
  }
  function replaceQuotes(value) {
    return value.replaceAll('"', "&quot;");
  }
  function formatAttributes(attributes, options, xmlMode) {
    if (!attributes)
      return "";
    const encode = (options.encodeEntities ?? options.decodeEntities) === false ? replaceQuotes : xmlMode || options.encodeEntities !== "utf8" ? encodeXML : escapeAttribute;
    const isForeign = xmlMode === "foreign";
    const showEmpty = !!(options.emptyAttrs ?? xmlMode);
    let result = "";
    for (const key in attributes) {
      if (!Object.hasOwn(attributes, key))
        continue;
      const value = attributes[key];
      const k = isForeign ? attributeNames.get(key) ?? key : key;
      result += !showEmpty && (value == null || value === "") ? ` ${k}` : ` ${k}="${encode(value == null ? "" : String(value))}"`;
    }
    return result;
  }

  // node_modules/.pnpm/domutils@4.0.2/node_modules/domutils/dist/stringify.js
  function getOuterHTML(node, options) {
    return dist_default(node, options);
  }
  function getInnerHTML(node, options) {
    return hasChildren(node) ? node.children.map((node2) => getOuterHTML(node2, options)).join("") : "";
  }
  function getText(node) {
    if (Array.isArray(node))
      return node.map(getText).join("");
    if (isTag2(node))
      return node.name === "br" ? "\n" : getText(node.children);
    if (isCDATA(node))
      return getText(node.children);
    if (isText(node))
      return node.data;
    return "";
  }
  function textContent(node) {
    if (Array.isArray(node))
      return node.map(textContent).join("");
    if (hasChildren(node) && !isComment(node)) {
      return textContent(node.children);
    }
    if (isText(node))
      return node.data;
    return "";
  }
  function innerText(node) {
    if (Array.isArray(node))
      return node.map(innerText).join("");
    if (hasChildren(node) && (node.type === ElementType.Tag || isCDATA(node))) {
      return innerText(node.children);
    }
    if (isText(node))
      return node.data;
    return "";
  }

  // node_modules/.pnpm/domutils@4.0.2/node_modules/domutils/dist/feeds.js
  function getFeed(document) {
    const feedRoot = getOneElement(isValidFeed, document);
    return feedRoot ? feedRoot.name === "feed" ? getAtomFeed(feedRoot) : getRssFeed(feedRoot) : null;
  }
  function getAtomFeed(feedRoot) {
    const childs = feedRoot.children;
    const feed = {
      type: "atom",
      items: getElementsByTagName("entry", childs).map((item) => {
        const { children } = item;
        const entry = { media: getMediaElements(children) };
        addConditionally(entry, "id", "id", children);
        addConditionally(entry, "title", "title", children);
        const href2 = getOneElement("link", children)?.attribs["href"];
        if (href2) {
          entry.link = href2;
        }
        const description = fetch("summary", children) || fetch("content", children);
        if (description) {
          entry.description = description;
        }
        const pubDate = fetch("updated", children);
        if (pubDate) {
          entry.pubDate = new Date(pubDate);
        }
        return entry;
      })
    };
    addConditionally(feed, "id", "id", childs);
    addConditionally(feed, "title", "title", childs);
    const href = getOneElement("link", childs)?.attribs["href"];
    if (href) {
      feed.link = href;
    }
    addConditionally(feed, "description", "subtitle", childs);
    const updated = fetch("updated", childs);
    if (updated) {
      feed.updated = new Date(updated);
    }
    addConditionally(feed, "author", "email", childs, true);
    return feed;
  }
  function getRssFeed(feedRoot) {
    const childs = getOneElement("channel", feedRoot.children)?.children ?? [];
    const feed = {
      type: feedRoot.name.substr(0, 3),
      id: "",
      items: getElementsByTagName("item", feedRoot.children).map((item) => {
        const { children } = item;
        const entry = { media: getMediaElements(children) };
        addConditionally(entry, "id", "guid", children);
        addConditionally(entry, "title", "title", children);
        addConditionally(entry, "link", "link", children);
        addConditionally(entry, "description", "description", children);
        const pubDate = fetch("pubDate", children) || fetch("dc:date", children);
        if (pubDate)
          entry.pubDate = new Date(pubDate);
        return entry;
      })
    };
    addConditionally(feed, "title", "title", childs);
    addConditionally(feed, "link", "link", childs);
    addConditionally(feed, "description", "description", childs);
    const updated = fetch("lastBuildDate", childs);
    if (updated) {
      feed.updated = new Date(updated);
    }
    addConditionally(feed, "author", "managingEditor", childs, true);
    return feed;
  }
  var MEDIA_KEYS_STRING = ["url", "type", "lang"];
  var MEDIA_KEYS_INT = [
    "fileSize",
    "bitrate",
    "framerate",
    "samplingrate",
    "channels",
    "duration",
    "height",
    "width"
  ];
  function getMediaElements(where) {
    return getElementsByTagName("media:content", where).map((element) => {
      const { attribs } = element;
      const media = {
        medium: attribs["medium"],
        isDefault: !!attribs["isDefault"]
      };
      for (const attrib of MEDIA_KEYS_STRING) {
        if (attribs[attrib]) {
          media[attrib] = attribs[attrib];
        }
      }
      for (const attrib of MEDIA_KEYS_INT) {
        if (attribs[attrib]) {
          media[attrib] = Number.parseInt(attribs[attrib], 10);
        }
      }
      if (attribs["expression"]) {
        media.expression = attribs["expression"];
      }
      return media;
    });
  }
  function getOneElement(tagName, node) {
    return getElementsByTagName(tagName, node, true, 1)[0];
  }
  function fetch(tagName, where, recurse = false) {
    return textContent(getElementsByTagName(tagName, where, recurse, 1)).trim();
  }
  function addConditionally(object, property, tagName, where, recurse = false) {
    const value = fetch(tagName, where, recurse);
    if (value)
      object[property] = value;
  }
  function isValidFeed(value) {
    return value === "rss" || value === "feed" || value === "rdf:RDF";
  }

  // node_modules/.pnpm/domutils@4.0.2/node_modules/domutils/dist/helpers.js
  function removeSubsets(nodes) {
    let index = nodes.length;
    while (--index >= 0) {
      const node = nodes[index];
      if (index > 0 && nodes.lastIndexOf(node, index - 1) >= 0) {
        nodes.splice(index, 1);
        continue;
      }
      for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
        if (nodes.includes(ancestor)) {
          nodes.splice(index, 1);
          break;
        }
      }
    }
    return nodes;
  }
  var DocumentPosition;
  (function(DocumentPosition2) {
    DocumentPosition2[DocumentPosition2["DISCONNECTED"] = 1] = "DISCONNECTED";
    DocumentPosition2[DocumentPosition2["PRECEDING"] = 2] = "PRECEDING";
    DocumentPosition2[DocumentPosition2["FOLLOWING"] = 4] = "FOLLOWING";
    DocumentPosition2[DocumentPosition2["CONTAINS"] = 8] = "CONTAINS";
    DocumentPosition2[DocumentPosition2["CONTAINED_BY"] = 16] = "CONTAINED_BY";
  })(DocumentPosition || (DocumentPosition = {}));
  function compareDocumentPosition(nodeA, nodeB) {
    const aParents = [];
    const bParents = [];
    if (nodeA === nodeB) {
      return 0;
    }
    let current = hasChildren(nodeA) ? nodeA : nodeA.parent;
    while (current) {
      aParents.unshift(current);
      current = current.parent;
    }
    current = hasChildren(nodeB) ? nodeB : nodeB.parent;
    while (current) {
      bParents.unshift(current);
      current = current.parent;
    }
    const maxIndex = Math.min(aParents.length, bParents.length);
    let index = 0;
    while (index < maxIndex && aParents[index] === bParents[index]) {
      index++;
    }
    if (index === 0) {
      return DocumentPosition.DISCONNECTED;
    }
    const sharedParent = aParents[index - 1];
    const siblings = sharedParent.children;
    const aSibling = aParents[index];
    const bSibling = bParents[index];
    if (siblings.indexOf(aSibling) > siblings.indexOf(bSibling)) {
      if (sharedParent === nodeB) {
        return DocumentPosition.FOLLOWING | DocumentPosition.CONTAINED_BY;
      }
      return DocumentPosition.FOLLOWING;
    }
    if (sharedParent === nodeA) {
      return DocumentPosition.PRECEDING | DocumentPosition.CONTAINS;
    }
    return DocumentPosition.PRECEDING;
  }
  function uniqueSort(nodes) {
    nodes = nodes.filter((node, index, array) => !array.includes(node, index + 1));
    nodes.sort((a, b) => {
      const relative = compareDocumentPosition(a, b);
      if (relative & DocumentPosition.PRECEDING) {
        return -1;
      }
      if (relative & DocumentPosition.FOLLOWING) {
        return 1;
      }
      return 0;
    });
    return nodes;
  }

  // node_modules/.pnpm/domutils@4.0.2/node_modules/domutils/dist/manipulation.js
  function removeElement(element) {
    if (element.prev)
      element.prev.next = element.next;
    if (element.next)
      element.next.prev = element.prev;
    if (element.parent) {
      const childs = element.parent.children;
      const childsIndex = childs.lastIndexOf(element);
      if (childsIndex !== -1) {
        childs.splice(childsIndex, 1);
      }
    }
    element.next = null;
    element.prev = null;
    element.parent = null;
  }
  function replaceElement(element, replacement) {
    replacement.prev = element.prev;
    if (replacement.prev) {
      replacement.prev.next = replacement;
    }
    replacement.next = element.next;
    if (replacement.next) {
      replacement.next.prev = replacement;
    }
    replacement.parent = element.parent;
    if (replacement.parent) {
      const { children } = replacement.parent;
      const elementIndex = children.lastIndexOf(element);
      if (elementIndex === -1) {
        return;
      }
      children[elementIndex] = replacement;
      element.parent = null;
    }
  }
  function appendChild(parent, child) {
    removeElement(child);
    child.next = null;
    child.parent = parent;
    if (parent.children.push(child) > 1) {
      const sibling = parent.children[parent.children.length - 2];
      sibling.next = child;
      child.prev = sibling;
    } else {
      child.prev = null;
    }
  }
  function append(element, next) {
    removeElement(next);
    const { parent } = element;
    const currentNext = element.next;
    next.next = currentNext;
    next.prev = element;
    element.next = next;
    next.parent = parent;
    if (currentNext) {
      currentNext.prev = next;
      if (parent) {
        const childs = parent.children;
        childs.splice(childs.lastIndexOf(currentNext), 0, next);
      }
    } else if (parent) {
      parent.children.push(next);
    }
  }
  function prependChild(parent, child) {
    removeElement(child);
    child.parent = parent;
    child.prev = null;
    if (parent.children.unshift(child) === 1) {
      child.next = null;
    } else {
      const sibling = parent.children[1];
      sibling.prev = child;
      child.next = sibling;
    }
  }
  function prepend(element, previous) {
    removeElement(previous);
    const { parent } = element;
    if (parent) {
      const childs = parent.children;
      childs.splice(childs.indexOf(element), 0, previous);
    }
    if (element.prev) {
      element.prev.next = previous;
    }
    previous.parent = parent;
    previous.prev = element.prev;
    previous.next = element;
    element.prev = previous;
  }

  // node_modules/.pnpm/domutils@4.0.2/node_modules/domutils/dist/traversal.js
  function getChildren(element) {
    return hasChildren(element) ? element.children : [];
  }
  function getParent(element) {
    return element.parent || null;
  }
  function getSiblings(element) {
    const parent = getParent(element);
    if (parent != null)
      return getChildren(parent);
    const siblings = [element];
    let { prev, next } = element;
    while (prev != null) {
      siblings.unshift(prev);
      ({ prev } = prev);
    }
    while (next != null) {
      siblings.push(next);
      ({ next } = next);
    }
    return siblings;
  }
  function getAttributeValue(element, name) {
    const { attribs } = element;
    return attribs?.[name];
  }
  function hasAttrib(element, name) {
    const { attribs } = element;
    return attribs != null && Object.hasOwn(attribs, name) && attribs[name] != null;
  }
  function getName(element) {
    return element.name;
  }
  function nextElementSibling(element) {
    let { next } = element;
    while (next !== null && !isTag2(next))
      ({ next } = next);
    return next;
  }
  function prevElementSibling(element) {
    let { prev } = element;
    while (prev !== null && !isTag2(prev))
      ({ prev } = prev);
    return prev;
  }

  // node_modules/.pnpm/css-select@7.0.0/node_modules/css-select/dist/attributes.js
  var reChars = /[-[\]{}()*+?.,\\^$|#\s]/g;
  var whitespaceRe = /\s/;
  function escapeRegex(value) {
    return value.replace(reChars, "\\$&");
  }
  var caseInsensitiveAttributes = /* @__PURE__ */ new Set([
    "accept",
    "accept-charset",
    "align",
    "alink",
    "axis",
    "bgcolor",
    "charset",
    "checked",
    "clear",
    "codetype",
    "color",
    "compact",
    "declare",
    "defer",
    "dir",
    "direction",
    "disabled",
    "enctype",
    "face",
    "frame",
    "hreflang",
    "http-equiv",
    "lang",
    "language",
    "link",
    "media",
    "method",
    "multiple",
    "nohref",
    "noresize",
    "noshade",
    "nowrap",
    "readonly",
    "rel",
    "rev",
    "rules",
    "scope",
    "scrolling",
    "selected",
    "shape",
    "target",
    "text",
    "type",
    "valign",
    "valuetype",
    "vlink"
  ]);
  function shouldIgnoreCase(selector, options) {
    return typeof selector.ignoreCase === "boolean" ? selector.ignoreCase : selector.ignoreCase === "quirks" ? !!options.quirksMode : !options.xmlMode && caseInsensitiveAttributes.has(selector.name);
  }
  var attributeRules = {
    equals(next, data, options) {
      const { adapter } = options;
      const { name } = data;
      let { value } = data;
      if (shouldIgnoreCase(data, options)) {
        value = value.toLowerCase();
        return (element) => {
          const attribute = adapter.getAttributeValue(element, name);
          return attribute != null && attribute.length === value.length && attribute.toLowerCase() === value && next(element);
        };
      }
      return (element) => adapter.getAttributeValue(element, name) === value && next(element);
    },
    hyphen(next, data, options) {
      const { adapter } = options;
      const { name } = data;
      let { value } = data;
      const { length } = value;
      if (shouldIgnoreCase(data, options)) {
        value = value.toLowerCase();
        return function hyphenIC(element) {
          const attribute = adapter.getAttributeValue(element, name);
          return attribute != null && (attribute.length === length || attribute.charAt(length) === "-") && attribute.substr(0, length).toLowerCase() === value && next(element);
        };
      }
      return function hyphen(element) {
        const attribute = adapter.getAttributeValue(element, name);
        return attribute != null && (attribute.length === length || attribute.charAt(length) === "-") && attribute.substr(0, length) === value && next(element);
      };
    },
    element(next, data, options) {
      const { adapter } = options;
      const { name, value } = data;
      if (whitespaceRe.test(value)) {
        return falseFunc;
      }
      const regex = new RegExp(`(?:^|\\s)${escapeRegex(value)}(?:$|\\s)`, shouldIgnoreCase(data, options) ? "i" : "");
      return function element(node) {
        const attribute = adapter.getAttributeValue(node, name);
        return attribute != null && attribute.length >= value.length && regex.test(attribute) && next(node);
      };
    },
    exists(next, { name }, { adapter }) {
      return (element) => adapter.hasAttrib(element, name) && next(element);
    },
    start(next, data, options) {
      const { adapter } = options;
      const { name } = data;
      let { value } = data;
      const { length } = value;
      if (length === 0) {
        return falseFunc;
      }
      if (shouldIgnoreCase(data, options)) {
        value = value.toLowerCase();
        return (element) => {
          const attribute = adapter.getAttributeValue(element, name);
          return attribute != null && attribute.length >= length && attribute.substr(0, length).toLowerCase() === value && next(element);
        };
      }
      return (element) => !!adapter.getAttributeValue(element, name)?.startsWith(value) && next(element);
    },
    end(next, data, options) {
      const { adapter } = options;
      const { name } = data;
      let { value } = data;
      const length = -value.length;
      if (length === 0) {
        return falseFunc;
      }
      if (shouldIgnoreCase(data, options)) {
        value = value.toLowerCase();
        return (element) => adapter.getAttributeValue(element, name)?.substr(length).toLowerCase() === value && next(element);
      }
      return (element) => !!adapter.getAttributeValue(element, name)?.endsWith(value) && next(element);
    },
    any(next, data, options) {
      const { adapter } = options;
      const { name, value } = data;
      if (value === "") {
        return falseFunc;
      }
      if (shouldIgnoreCase(data, options)) {
        const regex = new RegExp(escapeRegex(value), "i");
        return function anyIC(element) {
          const attribute = adapter.getAttributeValue(element, name);
          return attribute != null && attribute.length >= value.length && regex.test(attribute) && next(element);
        };
      }
      return (element) => !!adapter.getAttributeValue(element, name)?.includes(value) && next(element);
    },
    not(next, data, options) {
      const { adapter } = options;
      const { name } = data;
      let { value } = data;
      if (value === "") {
        return (element) => !!adapter.getAttributeValue(element, name) && next(element);
      }
      if (shouldIgnoreCase(data, options)) {
        value = value.toLowerCase();
        return (element) => {
          const attribute = adapter.getAttributeValue(element, name);
          return (attribute == null || attribute.length !== value.length || attribute.toLowerCase() !== value) && next(element);
        };
      }
      return (element) => adapter.getAttributeValue(element, name) !== value && next(element);
    }
  };

  // node_modules/.pnpm/css-select@7.0.0/node_modules/css-select/dist/helpers/querying.js
  function findAll2(query, nodes, options) {
    const { adapter, xmlMode = false } = options;
    const result = [];
    const nodeStack = [nodes];
    const indexStack = [0];
    for (; ; ) {
      if (indexStack[0] >= nodeStack[0].length) {
        if (nodeStack.length === 1) {
          return result;
        }
        nodeStack.shift();
        indexStack.shift();
        continue;
      }
      const element = nodeStack[0][indexStack[0]++];
      if (!adapter.isTag(element)) {
        continue;
      }
      if (query(element)) {
        result.push(element);
      }
      if (xmlMode || adapter.getName(element) !== "template") {
        const children = adapter.getChildren(element);
        if (children.length > 0) {
          nodeStack.unshift(children);
          indexStack.unshift(0);
        }
      }
    }
  }
  function findOne2(query, nodes, options) {
    const { adapter, xmlMode = false } = options;
    const nodeStack = [nodes];
    const indexStack = [0];
    for (; ; ) {
      if (indexStack[0] >= nodeStack[0].length) {
        if (nodeStack.length === 1) {
          return null;
        }
        nodeStack.shift();
        indexStack.shift();
        continue;
      }
      const element = nodeStack[0][indexStack[0]++];
      if (!adapter.isTag(element)) {
        continue;
      }
      if (query(element)) {
        return element;
      }
      if (xmlMode || adapter.getName(element) !== "template") {
        const children = adapter.getChildren(element);
        if (children.length > 0) {
          nodeStack.unshift(children);
          indexStack.unshift(0);
        }
      }
    }
  }
  function getNextSiblings(element, adapter) {
    const siblings = adapter.getSiblings(element);
    if (siblings.length <= 1) {
      return [];
    }
    const elementIndex = siblings.indexOf(element);
    if (elementIndex === -1 || elementIndex === siblings.length - 1) {
      return [];
    }
    return siblings.slice(elementIndex + 1).filter(adapter.isTag);
  }
  function getElementParent(node, adapter) {
    const parent = adapter.getParent(node);
    return parent != null && adapter.isTag(parent) ? parent : null;
  }

  // node_modules/.pnpm/css-select@7.0.0/node_modules/css-select/dist/pseudo-selectors/aliases.js
  var textControl = "input:is([type=text i],[type=search i],[type=url i],[type=tel i],[type=email i],[type=password i],[type=date i],[type=month i],[type=week i],[type=time i],[type=datetime-local i],[type=number i])";
  var aliases = {
    // Links
    "any-link": ":is(a, area, link)[href]",
    link: ":any-link:not(:visited)",
    // Forms
    // https://html.spec.whatwg.org/multipage/scripting.html#disabled-elements
    disabled: `:is(
        :is(button, input, select, textarea, optgroup, option)[disabled],
        optgroup[disabled] > option,
        fieldset[disabled]:not(fieldset[disabled] legend:first-of-type *)
    )`,
    enabled: ":is(button, input, select, textarea, optgroup, option, fieldset):not(:disabled)",
    checked: ":is(:is(input[type=radio], input[type=checkbox])[checked], :selected)",
    required: ":is(input, select, textarea)[required]",
    optional: ":is(input, select, textarea):not([required])",
    "read-only": `[readonly]:is(textarea, ${textControl})`,
    "read-write": `:not([readonly]):is(textarea, ${textControl})`,
    // JQuery extensions
    /**
     * `:selected` matches option elements that have the `selected` attribute,
     * or are the first option element in a select element that does not have
     * the `multiple` attribute and does not have any option elements with the
     * `selected` attribute.
     * @see https://html.spec.whatwg.org/multipage/form-elements.html#concept-option-selectedness
     */
    selected: "option:is([selected], select:not([multiple]):not(:has(> option[selected])) > :first-of-type)",
    checkbox: "[type=checkbox]",
    file: "[type=file]",
    password: "[type=password]",
    radio: "[type=radio]",
    reset: "[type=reset]",
    image: "[type=image]",
    submit: "[type=submit]",
    parent: ":not(:empty)",
    header: ":is(h1, h2, h3, h4, h5, h6)",
    button: ":is(button, input[type=button])",
    input: ":is(input, textarea, select, button)",
    text: "input:is(:not([type!='']), [type=text])"
  };

  // node_modules/.pnpm/nth-check@3.0.1/node_modules/nth-check/dist/compile.js
  function compile(parsed) {
    const a = parsed[0];
    const b = parsed[1] - 1;
    if (b < 0 && a <= 0)
      return falseFunc;
    if (a === -1)
      return (index) => index <= b;
    if (a === 0)
      return (index) => index === b;
    if (a === 1)
      return b < 0 ? trueFunc : (index) => index >= b;
    const absA = Math.abs(a);
    const bModulo = (b % absA + absA) % absA;
    return a > 1 ? (index) => index >= b && index % absA === bModulo : (index) => index <= b && index % absA === bModulo;
  }

  // node_modules/.pnpm/nth-check@3.0.1/node_modules/nth-check/dist/parse.js
  var whitespace = /* @__PURE__ */ new Set([9, 10, 12, 13, 32]);
  var ZERO = "0".charCodeAt(0);
  var NINE = "9".charCodeAt(0);
  function parse2(formula) {
    formula = formula.trim().toLowerCase();
    switch (formula) {
      case "even": {
        return [2, 0];
      }
      case "odd": {
        return [2, 1];
      }
    }
    let index = 0;
    let a = 0;
    let sign = readSign();
    let number = readNumber();
    if (index < formula.length && formula.charAt(index) === "n") {
      index++;
      a = sign * (number ?? 1);
      skipWhitespace();
      if (index < formula.length) {
        sign = readSign();
        skipWhitespace();
        number = readNumber();
      } else {
        sign = number = 0;
      }
    }
    if (number === null || index < formula.length) {
      throw new Error(`n-th rule couldn't be parsed ('${formula}')`);
    }
    return [a, sign * number];
    function readSign() {
      switch (formula.charAt(index)) {
        case "-": {
          index++;
          return -1;
        }
        case "+": {
          index++;
          break;
        }
      }
      return 1;
    }
    function readNumber() {
      const start = index;
      let value = 0;
      while (index < formula.length && formula.charCodeAt(index) >= ZERO && formula.charCodeAt(index) <= NINE) {
        value = value * 10 + (formula.charCodeAt(index) - ZERO);
        index++;
      }
      return index === start ? null : value;
    }
    function skipWhitespace() {
      while (index < formula.length && whitespace.has(formula.charCodeAt(index))) {
        index++;
      }
    }
  }

  // node_modules/.pnpm/nth-check@3.0.1/node_modules/nth-check/dist/index.js
  function nthCheck(formula) {
    return compile(parse2(formula));
  }

  // node_modules/.pnpm/css-select@7.0.0/node_modules/css-select/dist/helpers/cache.js
  function cacheParentResults(next, { adapter, cacheResults }, matches) {
    if (cacheResults === false || typeof WeakMap === "undefined") {
      return (element) => next(element) && matches(element);
    }
    const resultCache = /* @__PURE__ */ new WeakMap();
    function addResultToCache(element) {
      const result = matches(element);
      resultCache.set(element, result);
      return result;
    }
    return function cachedMatcher(element) {
      if (!next(element)) {
        return false;
      }
      if (resultCache.has(element)) {
        return resultCache.get(element) ?? false;
      }
      let node = element;
      do {
        const parent = getElementParent(node, adapter);
        if (parent === null) {
          return addResultToCache(element);
        }
        node = parent;
      } while (!resultCache.has(node));
      return resultCache.get(node) ? addResultToCache(element) : false;
    };
  }

  // node_modules/.pnpm/css-select@7.0.0/node_modules/css-select/dist/helpers/options.js
  function copyOptions(options) {
    const { context: _, rootFunc: __, ...copied } = options;
    return copied;
  }

  // node_modules/.pnpm/css-select@7.0.0/node_modules/css-select/dist/pseudo-selectors/filters.js
  function extendedFilter(tag, range) {
    if (range[0] !== "*" && range[0] !== tag[0])
      return false;
    let tagIndex = 1;
    for (let rangeIndex = 1; rangeIndex < range.length; rangeIndex++) {
      if (range[rangeIndex] === "*")
        continue;
      while (tagIndex < tag.length && tag[tagIndex] !== range[rangeIndex]) {
        if (tag[tagIndex++].length <= 1)
          return false;
      }
      if (tagIndex >= tag.length)
        return false;
      tagIndex++;
    }
    return true;
  }
  var nthOfRegex = /^(.+?)\s+of\s+(.+)$/is;
  function compileNth(reverse, ofType) {
    return function nth(next, rule, options, context, compileToken2) {
      const { adapter, equals } = options;
      const ofMatch = ofType ? null : rule.match(nthOfRegex);
      const nthCheck2 = nthCheck(ofMatch ? ofMatch[1].trim() : rule);
      if (nthCheck2 === falseFunc)
        return falseFunc;
      const ofSelector = ofMatch && compileToken2 ? compileToken2(parse(ofMatch[2].trim()), copyOptions(options), context) : void 0;
      if (ofSelector === falseFunc)
        return falseFunc;
      if (nthCheck2 === trueFunc && !ofSelector) {
        return (element) => getElementParent(element, adapter) !== null && next(element);
      }
      const shouldCount = ofSelector ? (_element, sibling) => ofSelector(sibling) : ofType ? (element, sibling) => adapter.getName(sibling) === adapter.getName(element) : trueFunc;
      if (reverse) {
        return function nthLast(element) {
          if (ofSelector && !ofSelector(element))
            return false;
          const siblings = adapter.getSiblings(element);
          let pos = 0;
          for (let index = siblings.length - 1; index >= 0; index--) {
            const sibling = siblings[index];
            if (equals(element, sibling))
              break;
            if (adapter.isTag(sibling) && shouldCount(element, sibling))
              pos++;
          }
          return nthCheck2(pos) && next(element);
        };
      }
      return function nth2(element) {
        if (ofSelector && !ofSelector(element))
          return false;
        const siblings = adapter.getSiblings(element);
        let pos = 0;
        for (const sibling of siblings) {
          if (equals(element, sibling))
            break;
          if (adapter.isTag(sibling) && shouldCount(element, sibling))
            pos++;
        }
        return nthCheck2(pos) && next(element);
      };
    };
  }
  var filters = {
    contains(next, text, options) {
      const { getText: getText2 } = options.adapter;
      return cacheParentResults(next, options, (element) => getText2(element).includes(text));
    },
    icontains(next, text, options) {
      const itext = text.toLowerCase();
      const { getText: getText2 } = options.adapter;
      return cacheParentResults(next, options, (element) => getText2(element).toLowerCase().includes(itext));
    },
    // Location specific methods
    "nth-child": compileNth(false, false),
    "nth-last-child": compileNth(true, false),
    "nth-of-type": compileNth(false, true),
    "nth-last-of-type": compileNth(true, true),
    // TODO determine the actual root element
    root(next, _rule, { adapter }) {
      return (element) => getElementParent(element, adapter) === null && next(element);
    },
    scope(next, rule, options, context) {
      const { equals } = options;
      if (!context || context.length === 0) {
        return filters["root"](next, rule, options);
      }
      if (context.length === 1) {
        return (element) => equals(context[0], element) && next(element);
      }
      return (element) => context.includes(element) && next(element);
    },
    lang(next, code, { adapter }) {
      const ranges = code.split(",").map((r) => r.trim()).filter((r) => r.length > 0).map((r) => r.replace(/^['"]|['"]$/g, "").toLowerCase().split("-"));
      return function lang(element) {
        let node = element;
        while (node != null) {
          const value = adapter.getAttributeValue(node, "xml:lang") ?? adapter.getAttributeValue(node, "lang");
          if (value != null) {
            if (!value) {
              return ranges.some((r) => r[0] === "") && next(element);
            }
            const tag = value.toLowerCase().split("-");
            return ranges.some((r) => extendedFilter(tag, r)) && next(element);
          }
          const parent = adapter.getParent(node);
          node = parent != null && adapter.isTag(parent) ? parent : null;
        }
        return ranges.some((r) => r[0] === "") && next(element);
      };
    },
    hover: dynamicStatePseudo("isHovered"),
    visited: dynamicStatePseudo("isVisited"),
    active: dynamicStatePseudo("isActive")
  };
  function dynamicStatePseudo(name) {
    return function dynamicPseudo(next, _rule, { adapter }) {
      const filterFunction = adapter[name];
      if (typeof filterFunction !== "function") {
        return falseFunc;
      }
      return function active(element) {
        return filterFunction(element) && next(element);
      };
    };
  }

  // node_modules/.pnpm/css-select@7.0.0/node_modules/css-select/dist/pseudo-selectors/pseudos.js
  var isDocumentWhiteSpace = /^[ \t\r\n]*$/;
  var pseudos = {
    empty(element, { adapter }) {
      const children = adapter.getChildren(element);
      return (
        // First, make sure the tag does not have any element children.
        children.every((element2) => !adapter.isTag(element2)) && // Then, check that the text content is only whitespace.
        children.every((element2) => (
          // FIXME: `getText` call is potentially expensive.
          isDocumentWhiteSpace.test(adapter.getText(element2))
        ))
      );
    },
    "first-child"(element, { adapter, equals }) {
      if (adapter.prevElementSibling) {
        return adapter.prevElementSibling(element) == null;
      }
      const firstChild = adapter.getSiblings(element).find((sibling) => adapter.isTag(sibling));
      return firstChild != null && equals(element, firstChild);
    },
    "last-child"(element, { adapter, equals }) {
      const siblings = adapter.getSiblings(element);
      for (let index = siblings.length - 1; index >= 0; index--) {
        if (equals(element, siblings[index])) {
          return true;
        }
        if (adapter.isTag(siblings[index])) {
          break;
        }
      }
      return false;
    },
    "first-of-type"(element, { adapter, equals }) {
      const siblings = adapter.getSiblings(element);
      const elementName = adapter.getName(element);
      for (const currentSibling of siblings) {
        if (equals(element, currentSibling)) {
          return true;
        }
        if (adapter.isTag(currentSibling) && adapter.getName(currentSibling) === elementName) {
          break;
        }
      }
      return false;
    },
    "last-of-type"(element, { adapter, equals }) {
      const siblings = adapter.getSiblings(element);
      const elementName = adapter.getName(element);
      for (let index = siblings.length - 1; index >= 0; index--) {
        const currentSibling = siblings[index];
        if (equals(element, currentSibling)) {
          return true;
        }
        if (adapter.isTag(currentSibling) && adapter.getName(currentSibling) === elementName) {
          break;
        }
      }
      return false;
    },
    "only-of-type"(element, { adapter, equals }) {
      const elementName = adapter.getName(element);
      return adapter.getSiblings(element).every((sibling) => equals(element, sibling) || !adapter.isTag(sibling) || adapter.getName(sibling) !== elementName);
    },
    "only-child"(element, { adapter, equals }) {
      return adapter.getSiblings(element).every((sibling) => equals(element, sibling) || !adapter.isTag(sibling));
    }
  };
  function verifyPseudoArguments(pseudoClassCondition, name, subselect, argumentIndex) {
    if (subselect === null) {
      if (pseudoClassCondition.length > argumentIndex) {
        throw new Error(`Pseudo-class :${name} requires an argument`);
      }
    } else if (pseudoClassCondition.length === argumentIndex) {
      throw new Error(`Pseudo-class :${name} doesn't have any arguments`);
    }
  }

  // node_modules/.pnpm/css-select@7.0.0/node_modules/css-select/dist/helpers/selectors.js
  function isTraversal2(token) {
    return token.type === "_flexibleDescendant" || isTraversal(token);
  }
  function sortRules(array) {
    const ratings = array.map(getQuality);
    for (let index = 1; index < array.length; index++) {
      const procNew = ratings[index];
      if (procNew < 0) {
        continue;
      }
      for (let currentIndex = index; currentIndex > 0 && procNew < ratings[currentIndex - 1]; currentIndex--) {
        const token = array[currentIndex];
        array[currentIndex] = array[currentIndex - 1];
        array[currentIndex - 1] = token;
        ratings[currentIndex] = ratings[currentIndex - 1];
        ratings[currentIndex - 1] = procNew;
      }
    }
  }
  function getAttributeQuality(token) {
    switch (token.action) {
      case AttributeAction.Exists: {
        return 10;
      }
      case AttributeAction.Equals: {
        return token.name === "id" ? 9 : 8;
      }
      case AttributeAction.Not: {
        return 7;
      }
      case AttributeAction.Start: {
        return 6;
      }
      case AttributeAction.End: {
        return 6;
      }
      case AttributeAction.Any: {
        return 5;
      }
      case AttributeAction.Hyphen: {
        return 4;
      }
      case AttributeAction.Element: {
        return 3;
      }
    }
  }
  function getQuality(token) {
    switch (token.type) {
      case SelectorType.Universal: {
        return 50;
      }
      case SelectorType.Tag: {
        return 30;
      }
      case SelectorType.Attribute: {
        return Math.floor(getAttributeQuality(token) / // `ignoreCase` adds some overhead, half the result if applicable.
        (token.ignoreCase ? 2 : 1));
      }
      case SelectorType.Pseudo: {
        return token.data ? token.name === "has" || token.name === "contains" || token.name === "icontains" ? (
          // Expensive in any case — run as late as possible.
          0
        ) : Array.isArray(token.data) ? (
          // Eg. `:is`, `:not`
          Math.max(
            // If we have traversals, try to avoid executing this selector
            0,
            Math.min(...token.data.map((d) => Math.min(...d.map(getQuality))))
          )
        ) : 2 : 3;
      }
      default: {
        return -1;
      }
    }
  }
  function includesScopePseudo(t) {
    return t.type === SelectorType.Pseudo && (t.name === "scope" || Array.isArray(t.data) && t.data.some((data) => data.some(includesScopePseudo)));
  }

  // node_modules/.pnpm/css-select@7.0.0/node_modules/css-select/dist/pseudo-selectors/subselects.js
  var PLACEHOLDER_ELEMENT = {};
  function hasDependsOnCurrentElement(selector) {
    return selector.some((sel) => sel.length > 0 && (isTraversal2(sel[0]) || sel.some(includesScopePseudo)));
  }
  var is = (next, token, options, context, compileToken2) => {
    const compiledToken = compileToken2(token, copyOptions(options), context);
    return compiledToken === trueFunc ? next : compiledToken === falseFunc ? falseFunc : (element) => compiledToken(element) && next(element);
  };
  var subselects = {
    is,
    /**
     * `:matches` and `:where` are aliases for `:is`.
     */
    matches: is,
    where: is,
    not(next, token, options, context, compileToken2) {
      const compiledToken = compileToken2(token, copyOptions(options), context);
      return compiledToken === falseFunc ? next : compiledToken === trueFunc ? falseFunc : (element) => !compiledToken(element) && next(element);
    },
    has(next, subselect, options, _context, compileToken2) {
      const { adapter } = options;
      const copiedOptions = copyOptions(options);
      copiedOptions.relativeSelector = true;
      const context = subselect.some((s) => s.some(isTraversal2)) ? (
        // Used as a placeholder. Will be replaced with the actual element.
        [PLACEHOLDER_ELEMENT]
      ) : void 0;
      const skipCache = hasDependsOnCurrentElement(subselect);
      const compiled = compileToken2(subselect, copiedOptions, context);
      if (compiled === falseFunc) {
        return falseFunc;
      }
      if (context && compiled !== trueFunc) {
        return skipCache ? (element) => {
          if (!next(element)) {
            return false;
          }
          context[0] = element;
          const childs = adapter.getChildren(element);
          return findOne2(compiled, compiled.shouldTestNextSiblings ? [
            ...childs,
            ...getNextSiblings(element, adapter)
          ] : childs, options) !== null;
        } : cacheParentResults(next, options, (element) => {
          context[0] = element;
          return findOne2(compiled, adapter.getChildren(element), options) !== null;
        });
      }
      const hasOne = (element) => findOne2(compiled, adapter.getChildren(element), options) !== null;
      return skipCache ? (element) => next(element) && hasOne(element) : cacheParentResults(next, options, hasOne);
    }
  };

  // node_modules/.pnpm/css-select@7.0.0/node_modules/css-select/dist/pseudo-selectors/index.js
  function compilePseudoSelector(next, selector, options, context, compileToken2) {
    const { name, data } = selector;
    if (Array.isArray(data)) {
      if (!(name in subselects)) {
        throw new Error(`Unknown pseudo-class :${name}(${data})`);
      }
      return subselects[name](next, data, options, context, compileToken2);
    }
    const userPseudo = options.pseudos?.[name];
    const stringPseudo = typeof userPseudo === "string" ? userPseudo : aliases[name];
    if (typeof stringPseudo === "string") {
      if (data != null) {
        throw new Error(`Pseudo ${name} doesn't have any arguments`);
      }
      const alias = parse(stringPseudo);
      return subselects["is"](next, alias, options, context, compileToken2);
    }
    if (typeof userPseudo === "function") {
      verifyPseudoArguments(userPseudo, name, data, 1);
      return (element) => userPseudo(element, data) && next(element);
    }
    if (name in filters) {
      return filters[name](next, data, options, context, compileToken2);
    }
    if (name in pseudos) {
      const pseudo = pseudos[name];
      verifyPseudoArguments(pseudo, name, data, 2);
      return (element) => pseudo(element, options, data) && next(element);
    }
    throw new Error(`Unknown pseudo-class :${name}`);
  }

  // node_modules/.pnpm/css-select@7.0.0/node_modules/css-select/dist/general.js
  function compileGeneralSelector(next, selector, options, context, compileToken2, hasExpensiveSubselector) {
    const { adapter, equals, cacheResults } = options;
    switch (selector.type) {
      case SelectorType.PseudoElement: {
        throw new Error("Pseudo-elements are not supported by css-select");
      }
      case SelectorType.ColumnCombinator: {
        throw new Error("Column combinators are not yet supported by css-select");
      }
      case SelectorType.Attribute: {
        if (selector.namespace != null) {
          throw new Error("Namespaced attributes are not yet supported by css-select");
        }
        if (!options.xmlMode || options.lowerCaseAttributeNames) {
          selector.name = selector.name.toLowerCase();
        }
        return attributeRules[selector.action](next, selector, options);
      }
      case SelectorType.Pseudo: {
        return compilePseudoSelector(next, selector, options, context, compileToken2);
      }
      // Tags
      case SelectorType.Tag: {
        if (selector.namespace != null) {
          throw new Error("Namespaced tag names are not yet supported by css-select");
        }
        let { name } = selector;
        if (!options.xmlMode || options.lowerCaseTags) {
          name = name.toLowerCase();
        }
        return function tag(element) {
          return adapter.getName(element) === name && next(element);
        };
      }
      // Traversal
      case SelectorType.Descendant: {
        if (!hasExpensiveSubselector || cacheResults === false || typeof WeakMap === "undefined") {
          return function descendant(element) {
            let current = element;
            while (current = getElementParent(current, adapter)) {
              if (next(current)) {
                return true;
              }
            }
            return false;
          };
        }
        const resultCache = /* @__PURE__ */ new WeakMap();
        return function cachedDescendant(element) {
          let current = element;
          let result;
          while (current = getElementParent(current, adapter)) {
            const cached = resultCache.get(current);
            if (cached === void 0) {
              result ??= { matches: false };
              result.matches = next(current);
              resultCache.set(current, result);
              if (result.matches) {
                return true;
              }
            } else {
              if (result) {
                result.matches = cached.matches;
              }
              return cached.matches;
            }
          }
          return false;
        };
      }
      case "_flexibleDescendant": {
        return function flexibleDescendant(element) {
          let current = element;
          do {
            if (next(current)) {
              return true;
            }
            current = getElementParent(current, adapter);
          } while (current);
          return false;
        };
      }
      case SelectorType.Parent: {
        return function parent(element) {
          return adapter.getChildren(element).some((element2) => adapter.isTag(element2) && next(element2));
        };
      }
      case SelectorType.Child: {
        return function child(element) {
          const parent = getElementParent(element, adapter);
          return parent !== null && next(parent);
        };
      }
      case SelectorType.Sibling: {
        return function sibling(element) {
          const siblings = adapter.getSiblings(element);
          for (const currentSibling of siblings) {
            if (equals(element, currentSibling)) {
              break;
            }
            if (adapter.isTag(currentSibling) && next(currentSibling)) {
              return true;
            }
          }
          return false;
        };
      }
      case SelectorType.Adjacent: {
        if (adapter.prevElementSibling) {
          return function adjacent(element) {
            const previous = adapter.prevElementSibling(element);
            return previous != null && next(previous);
          };
        }
        return function adjacent(element) {
          const siblings = adapter.getSiblings(element);
          let lastElement;
          for (const currentSibling of siblings) {
            if (equals(element, currentSibling)) {
              break;
            }
            if (adapter.isTag(currentSibling)) {
              lastElement = currentSibling;
            }
          }
          return !!lastElement && next(lastElement);
        };
      }
      case SelectorType.Universal: {
        if (selector.namespace != null && selector.namespace !== "*") {
          throw new Error("Namespaced universal selectors are not yet supported by css-select");
        }
        return next;
      }
    }
  }

  // node_modules/.pnpm/css-select@7.0.0/node_modules/css-select/dist/compile.js
  var DESCENDANT_TOKEN = { type: SelectorType.Descendant };
  var FLEXIBLE_DESCENDANT_TOKEN = {
    type: "_flexibleDescendant"
  };
  var SCOPE_TOKEN = {
    type: SelectorType.Pseudo,
    name: "scope",
    data: null
  };
  function absolutize(token, { adapter }, context) {
    const hasContext = !!context?.every((element) => element === PLACEHOLDER_ELEMENT || adapter.isTag(element) && getElementParent(element, adapter) !== null);
    for (const t of token) {
      if (t.length > 0 && isTraversal2(t[0]) && t[0].type !== SelectorType.Descendant) {
      } else if (hasContext && !t.some(includesScopePseudo)) {
        t.unshift(DESCENDANT_TOKEN);
      } else {
        continue;
      }
      t.unshift(SCOPE_TOKEN);
    }
  }
  function compileToken(token, options, compilationContext) {
    for (const rules of token) {
      sortRules(rules);
    }
    const { context = compilationContext, rootFunc: rootFunction = trueFunc } = options;
    const isArrayContext = Array.isArray(context);
    const finalContext = context && (Array.isArray(context) ? context : [context]);
    if (options.relativeSelector !== false) {
      absolutize(token, options, finalContext);
    } else if (token.some((t) => t.length > 0 && isTraversal2(t[0]))) {
      throw new Error("Relative selectors are not allowed when the `relativeSelector` option is disabled");
    }
    let shouldTestNextSiblings = false;
    let query = falseFunc;
    combineLoop: for (const rules of token) {
      if (rules.length >= 2) {
        const [first, second] = rules;
        if (first.type !== SelectorType.Pseudo || first.name !== "scope") {
        } else if (isArrayContext && second.type === SelectorType.Descendant) {
          rules[1] = FLEXIBLE_DESCENDANT_TOKEN;
        } else if (second.type === SelectorType.Adjacent || second.type === SelectorType.Sibling) {
          shouldTestNextSiblings = true;
        }
      }
      let next = rootFunction;
      let hasExpensiveSubselector = false;
      for (const rule of rules) {
        next = compileGeneralSelector(next, rule, options, finalContext, compileToken, hasExpensiveSubselector);
        const quality = getQuality(rule);
        if (quality === 0) {
          hasExpensiveSubselector = true;
        }
        if (next === falseFunc) {
          continue combineLoop;
        }
      }
      if (next === rootFunction) {
        return rootFunction;
      }
      query = query === falseFunc ? next : or(query, next);
    }
    query.shouldTestNextSiblings = shouldTestNextSiblings;
    return query;
  }
  function or(a, b) {
    return (element) => a(element) || b(element);
  }

  // node_modules/.pnpm/css-select@7.0.0/node_modules/css-select/dist/index.js
  var defaultEquals = (a, b) => a === b;
  var defaultOptions = {
    adapter: { ...dist_exports3, isTag: isTag2 },
    equals: defaultEquals
  };
  function convertOptionFormats(options) {
    const finalOptions = options ?? defaultOptions;
    finalOptions.adapter ??= defaultOptions.adapter;
    finalOptions.equals ??= finalOptions.adapter?.equals ?? defaultEquals;
    return finalOptions;
  }
  function compile2(selector, options, context) {
    const convertedOptions = convertOptionFormats(options);
    const next = _compileUnsafe(selector, convertedOptions, context);
    return next === falseFunc ? falseFunc : (element) => convertedOptions.adapter.isTag(element) && next(element);
  }
  function _compileUnsafe(selector, options, context) {
    return compileToken(typeof selector === "string" ? parse(selector) : selector, convertOptionFormats(options), context);
  }
  function getSelectorFunction(searchFunction) {
    return function select(query, elements, options) {
      const convertedOptions = convertOptionFormats(options);
      if (typeof query !== "function") {
        query = _compileUnsafe(query, convertedOptions, elements);
      }
      const filteredElements = prepareContext(elements, convertedOptions.adapter, query.shouldTestNextSiblings);
      return searchFunction(query, filteredElements, convertedOptions);
    };
  }
  function prepareContext(elements, adapter, shouldTestNextSiblings = false) {
    if (shouldTestNextSiblings) {
      elements = appendNextSiblings(elements, adapter);
    }
    return Array.isArray(elements) ? adapter.removeSubsets(elements) : adapter.getChildren(elements);
  }
  function appendNextSiblings(element, adapter) {
    const elements = Array.isArray(element) ? [...element] : [element];
    const elementsLength = elements.length;
    for (let index = 0; index < elementsLength; index++) {
      const nextSiblings = getNextSiblings(elements[index], adapter);
      elements.push(...nextSiblings);
    }
    return elements;
  }
  var selectAll = getSelectorFunction((query, elements, options) => query === falseFunc || !elements || elements.length === 0 ? [] : findAll2(query, elements, options));
  var selectOne = getSelectorFunction((query, elements, options) => query === falseFunc || !elements || elements.length === 0 ? null : findOne2(query, elements, options));
  function is2(element, query, options) {
    return (typeof query === "function" ? query : compile2(query, options))(element);
  }
  var dist_default2 = selectAll;
  return __toCommonJS(vendor_entry_exports);
})();
