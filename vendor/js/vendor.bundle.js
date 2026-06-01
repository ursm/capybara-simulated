var __csimVendor = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
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
    cssWhat: () => dist_exports,
    xpathway: () => src_exports
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
  __name(trueFunc, "trueFunc");
  function falseFunc() {
    return false;
  }
  __name(falseFunc, "falseFunc");

  // node_modules/.pnpm/css-what@8.0.0_patch_hash=9d7de52d0c35cef07f106951f275312a1a656a432429eb261560463984af218a/node_modules/css-what/dist/index.js
  var dist_exports = {};
  __export(dist_exports, {
    AttributeAction: () => AttributeAction,
    IgnoreCaseMode: () => IgnoreCaseMode,
    SelectorType: () => SelectorType,
    isTraversal: () => isTraversal,
    parse: () => parse,
    stringify: () => stringify
  });

  // node_modules/.pnpm/css-what@8.0.0_patch_hash=9d7de52d0c35cef07f106951f275312a1a656a432429eb261560463984af218a/node_modules/css-what/dist/types.js
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

  // node_modules/.pnpm/css-what@8.0.0_patch_hash=9d7de52d0c35cef07f106951f275312a1a656a432429eb261560463984af218a/node_modules/css-what/dist/parse.js
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
  __name(isTraversal, "isTraversal");
  var stripQuotesFromPseudos = /* @__PURE__ */ new Set(["contains", "icontains"]);
  function funescape(_, escaped, escapedWhitespace) {
    const codePoint = Number.parseInt(escaped, 16);
    if (Number.isNaN(codePoint) || escapedWhitespace)
      return escaped;
    if (codePoint === 0 || codePoint > 1114111 || codePoint >= 55296 && codePoint <= 57343)
      return "\uFFFD";
    return String.fromCodePoint(codePoint);
  }
  __name(funescape, "funescape");
  function unescapeCSS(cssString) {
    return cssString.replace(reEscape, funescape);
  }
  __name(unescapeCSS, "unescapeCSS");
  function isQuote(c) {
    return c === CharCode.SingleQuote || c === CharCode.DoubleQuote;
  }
  __name(isQuote, "isQuote");
  function isWhitespace(c) {
    return c === CharCode.Space || c === CharCode.Tab || c === CharCode.NewLine || c === CharCode.FormFeed || c === CharCode.CarriageReturn;
  }
  __name(isWhitespace, "isWhitespace");
  function parse(selector) {
    const subselects2 = [];
    const endIndex = parseSelector(subselects2, `${selector}`, 0);
    if (endIndex < selector.length) {
      throw new Error(`Unmatched selector: ${selector.slice(endIndex)}`);
    }
    return subselects2;
  }
  __name(parse, "parse");
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
    __name(getName2, "getName");
    function stripWhitespace(offset) {
      selectorIndex += offset;
      while (selectorIndex < selector.length && isWhitespace(selector.charCodeAt(selectorIndex))) {
        selectorIndex++;
      }
    }
    __name(stripWhitespace, "stripWhitespace");
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
    __name(readValueWithParenthesis, "readValueWithParenthesis");
    function ensureNotTraversal() {
      if (tokens.length > 0 && isTraversal(tokens[tokens.length - 1])) {
        throw new Error("Did not expect successive traversals.");
      }
    }
    __name(ensureNotTraversal, "ensureNotTraversal");
    function addTraversal(type) {
      if (tokens.length > 0 && tokens[tokens.length - 1].type === SelectorType.Descendant) {
        tokens[tokens.length - 1].type = type;
        return;
      }
      ensureNotTraversal();
      tokens.push({ type });
    }
    __name(addTraversal, "addTraversal");
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
    __name(addSpecialAttribute, "addSpecialAttribute");
    function finalizeSubselector() {
      if (tokens.length > 0 && tokens[tokens.length - 1].type === SelectorType.Descendant) {
        tokens.pop();
      }
      if (tokens.length === 0) {
        throw new Error("Empty sub-selector");
      }
      subselects2.push(tokens);
    }
    __name(finalizeSubselector, "finalizeSubselector");
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
  __name(parseSelector, "parseSelector");

  // node_modules/.pnpm/css-what@8.0.0_patch_hash=9d7de52d0c35cef07f106951f275312a1a656a432429eb261560463984af218a/node_modules/css-what/dist/stringify.js
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
  __name(stringify, "stringify");
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
  __name(stringifyToken, "stringifyToken");
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
  __name(getActionValue, "getActionValue");
  function getNamespacedName(token) {
    return `${getNamespace(token.namespace)}${escapeName(token.name, charsToEscapeInName)}`;
  }
  __name(getNamespacedName, "getNamespacedName");
  function getNamespace(namespace) {
    return namespace === null ? "" : `${namespace === "*" ? "*" : escapeName(namespace, charsToEscapeInName)}|`;
  }
  __name(getNamespace, "getNamespace");
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
  __name(escapeName, "escapeName");

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
  __name(isTag, "isTag");
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
  __name(isTag2, "isTag");
  function isCDATA(node) {
    return node.type === ElementType.CDATA;
  }
  __name(isCDATA, "isCDATA");
  function isText(node) {
    return node.type === ElementType.Text;
  }
  __name(isText, "isText");
  function isComment(node) {
    return node.type === ElementType.Comment;
  }
  __name(isComment, "isComment");
  function hasChildren(node) {
    return Object.hasOwn(node, "children");
  }
  __name(hasChildren, "hasChildren");

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
  __name(filter, "filter");
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
  __name(find, "find");
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
  __name(findOne, "findOne");
  function existsOne(test, nodes) {
    return (Array.isArray(nodes) ? nodes : [nodes]).some((node) => isTag2(node) && test(node) || hasChildren(node) && existsOne(test, node.children));
  }
  __name(existsOne, "existsOne");
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
  __name(findAll, "findAll");

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
  __name(getAttribCheck, "getAttribCheck");
  function combineFuncs(a, b) {
    return (element) => a(element) || b(element);
  }
  __name(combineFuncs, "combineFuncs");
  function compileTest(options) {
    const funcs = Object.keys(options).map((key) => {
      const value = options[key];
      return Object.hasOwn(Checks, key) ? Checks[key](value) : getAttribCheck(key, value);
    });
    return funcs.length === 0 ? null : funcs.reduce(combineFuncs);
  }
  __name(compileTest, "compileTest");
  function testElement(options, node) {
    const test = compileTest(options);
    return test ? test(node) : true;
  }
  __name(testElement, "testElement");
  function getElements(options, nodes, recurse, limit = Number.POSITIVE_INFINITY) {
    const test = compileTest(options);
    return test ? filter(test, nodes, recurse, limit) : [];
  }
  __name(getElements, "getElements");
  function getElementById(id, nodes, recurse = true) {
    if (!Array.isArray(nodes))
      nodes = [nodes];
    return findOne(getAttribCheck("id", id), nodes, recurse);
  }
  __name(getElementById, "getElementById");
  function getElementsByTagName(tagName, nodes, recurse = true, limit = Number.POSITIVE_INFINITY) {
    return filter(Checks["tag_name"](tagName), nodes, recurse, limit);
  }
  __name(getElementsByTagName, "getElementsByTagName");
  function getElementsByClassName(className, nodes, recurse = true, limit = Number.POSITIVE_INFINITY) {
    return filter(getAttribCheck("class", className), nodes, recurse, limit);
  }
  __name(getElementsByClassName, "getElementsByClassName");
  function getElementsByTagType(type, nodes, recurse = true, limit = Number.POSITIVE_INFINITY) {
    return filter(Checks["tag_type"](type), nodes, recurse, limit);
  }
  __name(getElementsByTagType, "getElementsByTagType");

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
  __name(encodeXML, "encodeXML");
  function getEscaper(regex, map) {
    return /* @__PURE__ */ __name(function escape2(data) {
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
    }, "escape");
  }
  __name(getEscaper, "getEscaper");
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
  __name(render, "render");
  var dist_default = render;
  function renderChildren(children, options, xmlMode) {
    let output = "";
    for (let index = 0; index < children.length; index++) {
      output += renderNode(children[index], options, xmlMode);
    }
    return output;
  }
  __name(renderChildren, "renderChildren");
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
  __name(renderNode, "renderNode");
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
  __name(renderTag, "renderTag");
  function replaceQuotes(value) {
    return value.replaceAll('"', "&quot;");
  }
  __name(replaceQuotes, "replaceQuotes");
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
  __name(formatAttributes, "formatAttributes");

  // node_modules/.pnpm/domutils@4.0.2/node_modules/domutils/dist/stringify.js
  function getOuterHTML(node, options) {
    return dist_default(node, options);
  }
  __name(getOuterHTML, "getOuterHTML");
  function getInnerHTML(node, options) {
    return hasChildren(node) ? node.children.map((node2) => getOuterHTML(node2, options)).join("") : "";
  }
  __name(getInnerHTML, "getInnerHTML");
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
  __name(getText, "getText");
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
  __name(textContent, "textContent");
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
  __name(innerText, "innerText");

  // node_modules/.pnpm/domutils@4.0.2/node_modules/domutils/dist/feeds.js
  function getFeed(document) {
    const feedRoot = getOneElement(isValidFeed, document);
    return feedRoot ? feedRoot.name === "feed" ? getAtomFeed(feedRoot) : getRssFeed(feedRoot) : null;
  }
  __name(getFeed, "getFeed");
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
  __name(getAtomFeed, "getAtomFeed");
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
  __name(getRssFeed, "getRssFeed");
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
  __name(getMediaElements, "getMediaElements");
  function getOneElement(tagName, node) {
    return getElementsByTagName(tagName, node, true, 1)[0];
  }
  __name(getOneElement, "getOneElement");
  function fetch(tagName, where, recurse = false) {
    return textContent(getElementsByTagName(tagName, where, recurse, 1)).trim();
  }
  __name(fetch, "fetch");
  function addConditionally(object, property, tagName, where, recurse = false) {
    const value = fetch(tagName, where, recurse);
    if (value)
      object[property] = value;
  }
  __name(addConditionally, "addConditionally");
  function isValidFeed(value) {
    return value === "rss" || value === "feed" || value === "rdf:RDF";
  }
  __name(isValidFeed, "isValidFeed");

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
  __name(removeSubsets, "removeSubsets");
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
  __name(compareDocumentPosition, "compareDocumentPosition");
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
  __name(uniqueSort, "uniqueSort");

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
  __name(removeElement, "removeElement");
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
  __name(replaceElement, "replaceElement");
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
  __name(appendChild, "appendChild");
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
  __name(append, "append");
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
  __name(prependChild, "prependChild");
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
  __name(prepend, "prepend");

  // node_modules/.pnpm/domutils@4.0.2/node_modules/domutils/dist/traversal.js
  function getChildren(element) {
    return hasChildren(element) ? element.children : [];
  }
  __name(getChildren, "getChildren");
  function getParent(element) {
    return element.parent || null;
  }
  __name(getParent, "getParent");
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
  __name(getSiblings, "getSiblings");
  function getAttributeValue(element, name) {
    const { attribs } = element;
    return attribs?.[name];
  }
  __name(getAttributeValue, "getAttributeValue");
  function hasAttrib(element, name) {
    const { attribs } = element;
    return attribs != null && Object.hasOwn(attribs, name) && attribs[name] != null;
  }
  __name(hasAttrib, "hasAttrib");
  function getName(element) {
    return element.name;
  }
  __name(getName, "getName");
  function nextElementSibling(element) {
    let { next } = element;
    while (next !== null && !isTag2(next))
      ({ next } = next);
    return next;
  }
  __name(nextElementSibling, "nextElementSibling");
  function prevElementSibling(element) {
    let { prev } = element;
    while (prev !== null && !isTag2(prev))
      ({ prev } = prev);
    return prev;
  }
  __name(prevElementSibling, "prevElementSibling");

  // node_modules/.pnpm/css-select@7.0.0/node_modules/css-select/dist/attributes.js
  var reChars = /[-[\]{}()*+?.,\\^$|#\s]/g;
  var whitespaceRe = /\s/;
  function escapeRegex(value) {
    return value.replace(reChars, "\\$&");
  }
  __name(escapeRegex, "escapeRegex");
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
  __name(shouldIgnoreCase, "shouldIgnoreCase");
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
        return /* @__PURE__ */ __name(function hyphenIC(element) {
          const attribute = adapter.getAttributeValue(element, name);
          return attribute != null && (attribute.length === length || attribute.charAt(length) === "-") && attribute.substr(0, length).toLowerCase() === value && next(element);
        }, "hyphenIC");
      }
      return /* @__PURE__ */ __name(function hyphen(element) {
        const attribute = adapter.getAttributeValue(element, name);
        return attribute != null && (attribute.length === length || attribute.charAt(length) === "-") && attribute.substr(0, length) === value && next(element);
      }, "hyphen");
    },
    element(next, data, options) {
      const { adapter } = options;
      const { name, value } = data;
      if (whitespaceRe.test(value)) {
        return falseFunc;
      }
      const regex = new RegExp(`(?:^|\\s)${escapeRegex(value)}(?:$|\\s)`, shouldIgnoreCase(data, options) ? "i" : "");
      return /* @__PURE__ */ __name(function element(node) {
        const attribute = adapter.getAttributeValue(node, name);
        return attribute != null && attribute.length >= value.length && regex.test(attribute) && next(node);
      }, "element");
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
        return /* @__PURE__ */ __name(function anyIC(element) {
          const attribute = adapter.getAttributeValue(element, name);
          return attribute != null && attribute.length >= value.length && regex.test(attribute) && next(element);
        }, "anyIC");
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
  __name(findAll2, "findAll");
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
  __name(findOne2, "findOne");
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
  __name(getNextSiblings, "getNextSiblings");
  function getElementParent(node, adapter) {
    const parent = adapter.getParent(node);
    return parent != null && adapter.isTag(parent) ? parent : null;
  }
  __name(getElementParent, "getElementParent");

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
  __name(compile, "compile");

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
    __name(readSign, "readSign");
    function readNumber() {
      const start = index;
      let value = 0;
      while (index < formula.length && formula.charCodeAt(index) >= ZERO && formula.charCodeAt(index) <= NINE) {
        value = value * 10 + (formula.charCodeAt(index) - ZERO);
        index++;
      }
      return index === start ? null : value;
    }
    __name(readNumber, "readNumber");
    function skipWhitespace() {
      while (index < formula.length && whitespace.has(formula.charCodeAt(index))) {
        index++;
      }
    }
    __name(skipWhitespace, "skipWhitespace");
  }
  __name(parse2, "parse");

  // node_modules/.pnpm/nth-check@3.0.1/node_modules/nth-check/dist/index.js
  function nthCheck(formula) {
    return compile(parse2(formula));
  }
  __name(nthCheck, "nthCheck");

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
    __name(addResultToCache, "addResultToCache");
    return /* @__PURE__ */ __name(function cachedMatcher(element) {
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
    }, "cachedMatcher");
  }
  __name(cacheParentResults, "cacheParentResults");

  // node_modules/.pnpm/css-select@7.0.0/node_modules/css-select/dist/helpers/options.js
  function copyOptions(options) {
    const { context: _, rootFunc: __, ...copied } = options;
    return copied;
  }
  __name(copyOptions, "copyOptions");

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
  __name(extendedFilter, "extendedFilter");
  var nthOfRegex = /^(.+?)\s+of\s+(.+)$/is;
  function compileNth(reverse, ofType) {
    return /* @__PURE__ */ __name(function nth(next, rule, options, context, compileToken2) {
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
        return /* @__PURE__ */ __name(function nthLast(element) {
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
        }, "nthLast");
      }
      return /* @__PURE__ */ __name(function nth2(element) {
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
      }, "nth");
    }, "nth");
  }
  __name(compileNth, "compileNth");
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
      return /* @__PURE__ */ __name(function lang(element) {
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
      }, "lang");
    },
    hover: dynamicStatePseudo("isHovered"),
    visited: dynamicStatePseudo("isVisited"),
    active: dynamicStatePseudo("isActive")
  };
  function dynamicStatePseudo(name) {
    return /* @__PURE__ */ __name(function dynamicPseudo(next, _rule, { adapter }) {
      const filterFunction = adapter[name];
      if (typeof filterFunction !== "function") {
        return falseFunc;
      }
      return /* @__PURE__ */ __name(function active(element) {
        return filterFunction(element) && next(element);
      }, "active");
    }, "dynamicPseudo");
  }
  __name(dynamicStatePseudo, "dynamicStatePseudo");

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
  __name(verifyPseudoArguments, "verifyPseudoArguments");

  // node_modules/.pnpm/css-select@7.0.0/node_modules/css-select/dist/helpers/selectors.js
  function isTraversal2(token) {
    return token.type === "_flexibleDescendant" || isTraversal(token);
  }
  __name(isTraversal2, "isTraversal");
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
  __name(sortRules, "sortRules");
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
  __name(getAttributeQuality, "getAttributeQuality");
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
  __name(getQuality, "getQuality");
  function includesScopePseudo(t) {
    return t.type === SelectorType.Pseudo && (t.name === "scope" || Array.isArray(t.data) && t.data.some((data) => data.some(includesScopePseudo)));
  }
  __name(includesScopePseudo, "includesScopePseudo");

  // node_modules/.pnpm/css-select@7.0.0/node_modules/css-select/dist/pseudo-selectors/subselects.js
  var PLACEHOLDER_ELEMENT = {};
  function hasDependsOnCurrentElement(selector) {
    return selector.some((sel) => sel.length > 0 && (isTraversal2(sel[0]) || sel.some(includesScopePseudo)));
  }
  __name(hasDependsOnCurrentElement, "hasDependsOnCurrentElement");
  var is = /* @__PURE__ */ __name((next, token, options, context, compileToken2) => {
    const compiledToken = compileToken2(token, copyOptions(options), context);
    return compiledToken === trueFunc ? next : compiledToken === falseFunc ? falseFunc : (element) => compiledToken(element) && next(element);
  }, "is");
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
      const hasOne = /* @__PURE__ */ __name((element) => findOne2(compiled, adapter.getChildren(element), options) !== null, "hasOne");
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
  __name(compilePseudoSelector, "compilePseudoSelector");

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
        return /* @__PURE__ */ __name(function tag(element) {
          return adapter.getName(element) === name && next(element);
        }, "tag");
      }
      // Traversal
      case SelectorType.Descendant: {
        if (!hasExpensiveSubselector || cacheResults === false || typeof WeakMap === "undefined") {
          return /* @__PURE__ */ __name(function descendant(element) {
            let current = element;
            while (current = getElementParent(current, adapter)) {
              if (next(current)) {
                return true;
              }
            }
            return false;
          }, "descendant");
        }
        const resultCache = /* @__PURE__ */ new WeakMap();
        return /* @__PURE__ */ __name(function cachedDescendant(element) {
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
        }, "cachedDescendant");
      }
      case "_flexibleDescendant": {
        return /* @__PURE__ */ __name(function flexibleDescendant(element) {
          let current = element;
          do {
            if (next(current)) {
              return true;
            }
            current = getElementParent(current, adapter);
          } while (current);
          return false;
        }, "flexibleDescendant");
      }
      case SelectorType.Parent: {
        return /* @__PURE__ */ __name(function parent(element) {
          return adapter.getChildren(element).some((element2) => adapter.isTag(element2) && next(element2));
        }, "parent");
      }
      case SelectorType.Child: {
        return /* @__PURE__ */ __name(function child(element) {
          const parent = getElementParent(element, adapter);
          return parent !== null && next(parent);
        }, "child");
      }
      case SelectorType.Sibling: {
        return /* @__PURE__ */ __name(function sibling(element) {
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
        }, "sibling");
      }
      case SelectorType.Adjacent: {
        if (adapter.prevElementSibling) {
          return /* @__PURE__ */ __name(function adjacent(element) {
            const previous = adapter.prevElementSibling(element);
            return previous != null && next(previous);
          }, "adjacent");
        }
        return /* @__PURE__ */ __name(function adjacent(element) {
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
        }, "adjacent");
      }
      case SelectorType.Universal: {
        if (selector.namespace != null && selector.namespace !== "*") {
          throw new Error("Namespaced universal selectors are not yet supported by css-select");
        }
        return next;
      }
    }
  }
  __name(compileGeneralSelector, "compileGeneralSelector");

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
  __name(absolutize, "absolutize");
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
  __name(compileToken, "compileToken");
  function or(a, b) {
    return (element) => a(element) || b(element);
  }
  __name(or, "or");

  // node_modules/.pnpm/css-select@7.0.0/node_modules/css-select/dist/index.js
  var defaultEquals = /* @__PURE__ */ __name((a, b) => a === b, "defaultEquals");
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
  __name(convertOptionFormats, "convertOptionFormats");
  function compile2(selector, options, context) {
    const convertedOptions = convertOptionFormats(options);
    const next = _compileUnsafe(selector, convertedOptions, context);
    return next === falseFunc ? falseFunc : (element) => convertedOptions.adapter.isTag(element) && next(element);
  }
  __name(compile2, "compile");
  function _compileUnsafe(selector, options, context) {
    return compileToken(typeof selector === "string" ? parse(selector) : selector, convertOptionFormats(options), context);
  }
  __name(_compileUnsafe, "_compileUnsafe");
  function getSelectorFunction(searchFunction) {
    return /* @__PURE__ */ __name(function select(query, elements, options) {
      const convertedOptions = convertOptionFormats(options);
      if (typeof query !== "function") {
        query = _compileUnsafe(query, convertedOptions, elements);
      }
      const filteredElements = prepareContext(elements, convertedOptions.adapter, query.shouldTestNextSiblings);
      return searchFunction(query, filteredElements, convertedOptions);
    }, "select");
  }
  __name(getSelectorFunction, "getSelectorFunction");
  function prepareContext(elements, adapter, shouldTestNextSiblings = false) {
    if (shouldTestNextSiblings) {
      elements = appendNextSiblings(elements, adapter);
    }
    return Array.isArray(elements) ? adapter.removeSubsets(elements) : adapter.getChildren(elements);
  }
  __name(prepareContext, "prepareContext");
  function appendNextSiblings(element, adapter) {
    const elements = Array.isArray(element) ? [...element] : [element];
    const elementsLength = elements.length;
    for (let index = 0; index < elementsLength; index++) {
      const nextSiblings = getNextSiblings(elements[index], adapter);
      elements.push(...nextSiblings);
    }
    return elements;
  }
  __name(appendNextSiblings, "appendNextSiblings");
  var selectAll = getSelectorFunction((query, elements, options) => query === falseFunc || !elements || elements.length === 0 ? [] : findAll2(query, elements, options));
  var selectOne = getSelectorFunction((query, elements, options) => query === falseFunc || !elements || elements.length === 0 ? null : findOne2(query, elements, options));
  function is2(element, query, options) {
    return (typeof query === "function" ? query : compile2(query, options))(element);
  }
  __name(is2, "is");
  var dist_default2 = selectAll;

  // node_modules/.pnpm/xpathway@1.0.0/node_modules/xpathway/src/index.js
  var src_exports = {};
  __export(src_exports, {
    AXES: () => AXES,
    NodeSet: () => NodeSet,
    T: () => T,
    XPathResult: () => XPathResult,
    XPathSyntaxError: () => XPathSyntaxError,
    XPathTypeError: () => XPathTypeError,
    coreFunctions: () => coreFunctions,
    createEvaluator: () => createEvaluator,
    evaluate: () => evaluate,
    isNodeSet: () => isNodeSet,
    makeRootContext: () => makeRootContext,
    numberToString: () => numberToString,
    parse: () => parse3,
    stringToNumber: () => stringToNumber,
    toBoolean: () => toBoolean,
    toNumber: () => toNumber,
    toStr: () => toStr,
    tokenize: () => tokenize
  });

  // node_modules/.pnpm/xpathway@1.0.0/node_modules/xpathway/src/errors.js
  var XPathSyntaxError = class extends Error {
    static {
      __name(this, "XPathSyntaxError");
    }
    constructor(message, pos) {
      super(pos == null ? message : `${message} (at position ${pos})`);
      this.name = "XPathSyntaxError";
      this.pos = pos ?? null;
    }
  };
  var XPathTypeError = class extends Error {
    static {
      __name(this, "XPathTypeError");
    }
    constructor(message) {
      super(message);
      this.name = "XPathTypeError";
    }
  };

  // node_modules/.pnpm/xpathway@1.0.0/node_modules/xpathway/src/lexer.js
  var T = {
    LPAREN: "LPAREN",
    RPAREN: "RPAREN",
    LBRACKET: "LBRACKET",
    RBRACKET: "RBRACKET",
    AT: "AT",
    COMMA: "COMMA",
    DOUBLECOLON: "DOUBLECOLON",
    SLASH: "SLASH",
    DOUBLESLASH: "DOUBLESLASH",
    DOT: "DOT",
    DOTDOT: "DOTDOT",
    PIPE: "PIPE",
    PLUS: "PLUS",
    MINUS: "MINUS",
    EQ: "EQ",
    NE: "NE",
    LT: "LT",
    LE: "LE",
    GT: "GT",
    GE: "GE",
    MULTIPLY: "MULTIPLY",
    AND: "AND",
    OR: "OR",
    MOD: "MOD",
    DIV: "DIV",
    AXISNAME: "AXISNAME",
    NODETYPE: "NODETYPE",
    FUNCNAME: "FUNCNAME",
    NAMETEST: "NAMETEST",
    // value: { prefix: string|null, local: string|'*' }
    NUMBER: "NUMBER",
    LITERAL: "LITERAL",
    VARREF: "VARREF",
    EOF: "EOF"
  };
  var FORCE_NAME_AFTER = /* @__PURE__ */ new Set([
    T.AT,
    T.DOUBLECOLON,
    T.LPAREN,
    T.LBRACKET,
    T.COMMA,
    T.SLASH,
    T.DOUBLESLASH,
    T.PIPE,
    T.PLUS,
    T.MINUS,
    T.EQ,
    T.NE,
    T.LT,
    T.LE,
    T.GT,
    T.GE,
    T.MULTIPLY,
    T.AND,
    T.OR,
    T.MOD,
    T.DIV
  ]);
  var OPERATOR_NAMES = /* @__PURE__ */ new Map([
    ["and", T.AND],
    ["or", T.OR],
    ["mod", T.MOD],
    ["div", T.DIV]
  ]);
  var NODE_TYPES = /* @__PURE__ */ new Set(["node", "text", "comment", "processing-instruction"]);
  function isDigit(ch) {
    return ch >= "0" && ch <= "9";
  }
  __name(isDigit, "isDigit");
  function isNameStart(ch) {
    return ch >= "A" && ch <= "Z" || ch >= "a" && ch <= "z" || ch === "_" || ch.charCodeAt(0) >= 128;
  }
  __name(isNameStart, "isNameStart");
  function isNameChar(ch) {
    return isNameStart(ch) || isDigit(ch) || ch === "-" || ch === ".";
  }
  __name(isNameChar, "isNameChar");
  function isWhitespace2(ch) {
    return ch === " " || ch === "	" || ch === "\r" || ch === "\n";
  }
  __name(isWhitespace2, "isWhitespace");
  function tokenize(expr) {
    if (typeof expr !== "string") {
      throw new XPathSyntaxError("expression must be a string");
    }
    const tokens = [];
    let i = 0;
    const n = expr.length;
    const prevType = /* @__PURE__ */ __name(() => tokens.length ? tokens[tokens.length - 1].type : null, "prevType");
    const inOperatorPosition = /* @__PURE__ */ __name(() => tokens.length > 0 && !FORCE_NAME_AFTER.has(prevType()), "inOperatorPosition");
    const push = /* @__PURE__ */ __name((type, value, pos) => tokens.push({ type, value, pos }), "push");
    const skipWs = /* @__PURE__ */ __name((from) => {
      let j = from;
      while (j < n && isWhitespace2(expr[j])) j++;
      return j;
    }, "skipWs");
    while (i < n) {
      const ch = expr[i];
      if (isWhitespace2(ch)) {
        i++;
        continue;
      }
      const start = i;
      if (ch === "/") {
        if (expr[i + 1] === "/") {
          push(T.DOUBLESLASH, "//", start);
          i += 2;
        } else {
          push(T.SLASH, "/", start);
          i += 1;
        }
        continue;
      }
      if (ch === "!") {
        if (expr[i + 1] === "=") {
          push(T.NE, "!=", start);
          i += 2;
          continue;
        }
        throw new XPathSyntaxError("unexpected '!'", start);
      }
      if (ch === "<") {
        if (expr[i + 1] === "=") {
          push(T.LE, "<=", start);
          i += 2;
        } else {
          push(T.LT, "<", start);
          i += 1;
        }
        continue;
      }
      if (ch === ">") {
        if (expr[i + 1] === "=") {
          push(T.GE, ">=", start);
          i += 2;
        } else {
          push(T.GT, ">", start);
          i += 1;
        }
        continue;
      }
      if (ch === "=") {
        push(T.EQ, "=", start);
        i += 1;
        continue;
      }
      if (ch === "|") {
        push(T.PIPE, "|", start);
        i += 1;
        continue;
      }
      if (ch === "+") {
        push(T.PLUS, "+", start);
        i += 1;
        continue;
      }
      if (ch === "-") {
        push(T.MINUS, "-", start);
        i += 1;
        continue;
      }
      if (ch === "(") {
        push(T.LPAREN, "(", start);
        i += 1;
        continue;
      }
      if (ch === ")") {
        push(T.RPAREN, ")", start);
        i += 1;
        continue;
      }
      if (ch === "[") {
        push(T.LBRACKET, "[", start);
        i += 1;
        continue;
      }
      if (ch === "]") {
        push(T.RBRACKET, "]", start);
        i += 1;
        continue;
      }
      if (ch === ",") {
        push(T.COMMA, ",", start);
        i += 1;
        continue;
      }
      if (ch === "@") {
        push(T.AT, "@", start);
        i += 1;
        continue;
      }
      if (ch === ":" && expr[i + 1] === ":") {
        push(T.DOUBLECOLON, "::", start);
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        i += 1;
        let value = "";
        while (i < n && expr[i] !== ch) {
          value += expr[i];
          i += 1;
        }
        if (i >= n) {
          throw new XPathSyntaxError("unterminated string literal", start);
        }
        i += 1;
        push(T.LITERAL, value, start);
        continue;
      }
      if (isDigit(ch) || ch === "." && isDigit(expr[i + 1])) {
        let value = "";
        while (i < n && isDigit(expr[i])) {
          value += expr[i];
          i += 1;
        }
        if (expr[i] === "." && expr[i + 1] !== ".") {
          value += ".";
          i += 1;
          while (i < n && isDigit(expr[i])) {
            value += expr[i];
            i += 1;
          }
        }
        push(T.NUMBER, Number(value), start);
        continue;
      }
      if (ch === ".") {
        if (expr[i + 1] === ".") {
          push(T.DOTDOT, "..", start);
          i += 2;
        } else {
          push(T.DOT, ".", start);
          i += 1;
        }
        continue;
      }
      if (ch === "$") {
        i += 1;
        const name = readQNameString(expr, i);
        if (name == null) {
          throw new XPathSyntaxError("expected name after '$'", start);
        }
        i = name.end;
        push(T.VARREF, name.value, start);
        continue;
      }
      if (ch === "*") {
        if (inOperatorPosition()) {
          push(T.MULTIPLY, "*", start);
        } else {
          push(T.NAMETEST, { prefix: null, local: "*" }, start);
        }
        i += 1;
        continue;
      }
      if (isNameStart(ch)) {
        const parsed = readName(expr, i);
        i = parsed.end;
        const { prefix, local } = parsed;
        const after = skipWs(i);
        const followedByParen = expr[after] === "(";
        const followedByDoubleColon = expr[after] === ":" && expr[after + 1] === ":";
        if (prefix == null && local !== "*" && inOperatorPosition() && OPERATOR_NAMES.has(local)) {
          push(OPERATOR_NAMES.get(local), local, start);
          continue;
        }
        if (followedByDoubleColon && prefix == null && local !== "*") {
          push(T.AXISNAME, local, start);
          continue;
        }
        if (followedByParen && prefix == null && local !== "*") {
          if (NODE_TYPES.has(local)) {
            push(T.NODETYPE, local, start);
          } else {
            push(T.FUNCNAME, { prefix: null, local }, start);
          }
          continue;
        }
        if (followedByParen && prefix != null) {
          push(T.FUNCNAME, { prefix, local }, start);
          continue;
        }
        push(T.NAMETEST, { prefix, local }, start);
        continue;
      }
      throw new XPathSyntaxError(`unexpected character '${ch}'`, start);
    }
    push(T.EOF, null, n);
    return tokens;
  }
  __name(tokenize, "tokenize");
  function ncNameEnd(expr, start) {
    const n = expr.length;
    let i = start + 1;
    while (i < n && isNameChar(expr[i])) i++;
    return i;
  }
  __name(ncNameEnd, "ncNameEnd");
  function readQNameString(expr, start) {
    if (start >= expr.length || !isNameStart(expr[start])) return null;
    let i = ncNameEnd(expr, start);
    if (expr[i] === ":" && expr[i + 1] !== ":" && isNameStart(expr[i + 1] ?? "")) {
      i = ncNameEnd(expr, i + 1);
    }
    return { value: expr.slice(start, i), end: i };
  }
  __name(readQNameString, "readQNameString");
  function readName(expr, start) {
    const i = ncNameEnd(expr, start);
    const first = expr.slice(start, i);
    if (expr[i] === ":" && expr[i + 1] !== ":") {
      if (expr[i + 1] === "*") {
        return { prefix: first, local: "*", end: i + 2 };
      }
      if (isNameStart(expr[i + 1] ?? "")) {
        const j = ncNameEnd(expr, i + 1);
        return { prefix: first, local: expr.slice(i + 1, j), end: j };
      }
      throw new XPathSyntaxError(`expected name after ':' in '${first}:'`, i);
    }
    return { prefix: null, local: first, end: i };
  }
  __name(readName, "readName");

  // node_modules/.pnpm/xpathway@1.0.0/node_modules/xpathway/src/parser.js
  var AXES = /* @__PURE__ */ new Set([
    "ancestor",
    "ancestor-or-self",
    "attribute",
    "child",
    "descendant",
    "descendant-or-self",
    "following",
    "following-sibling",
    "namespace",
    "parent",
    "preceding",
    "preceding-sibling",
    "self"
  ]);
  var STEP_START = /* @__PURE__ */ new Set([T.AT, T.AXISNAME, T.NAMETEST, T.NODETYPE, T.DOT, T.DOTDOT]);
  var PRIMARY_START = /* @__PURE__ */ new Set([T.LPAREN, T.LITERAL, T.NUMBER, T.FUNCNAME, T.VARREF]);
  var OR_OPS = { [T.OR]: "or" };
  var AND_OPS = { [T.AND]: "and" };
  var EQUALITY_OPS = { [T.EQ]: "=", [T.NE]: "!=" };
  var RELATIONAL_OPS = { [T.LT]: "<", [T.LE]: "<=", [T.GT]: ">", [T.GE]: ">=" };
  var ADDITIVE_OPS = { [T.PLUS]: "+", [T.MINUS]: "-" };
  var MULTIPLICATIVE_OPS = { [T.MULTIPLY]: "*", [T.DIV]: "div", [T.MOD]: "mod" };
  function nodeTypeStep(axis, name) {
    return { type: "Step", axis, nodeTest: { kind: "type", name, literal: null }, predicates: [] };
  }
  __name(nodeTypeStep, "nodeTypeStep");
  function descendantOrSelfStep() {
    return nodeTypeStep("descendant-or-self", "node");
  }
  __name(descendantOrSelfStep, "descendantOrSelfStep");
  var Parser = class {
    static {
      __name(this, "Parser");
    }
    constructor(tokens) {
      this.tokens = tokens;
      this.pos = 0;
    }
    peek() {
      return this.tokens[this.pos];
    }
    next() {
      return this.tokens[this.pos++];
    }
    is(type) {
      return this.tokens[this.pos].type === type;
    }
    expect(type) {
      const tok = this.tokens[this.pos];
      if (tok.type !== type) {
        throw new XPathSyntaxError(`expected ${type} but found ${tok.type}`, tok.pos);
      }
      return this.next();
    }
    parse() {
      const expr = this.parseExpr();
      if (!this.is(T.EOF)) {
        const tok = this.peek();
        throw new XPathSyntaxError(`unexpected trailing token ${tok.type}`, tok.pos);
      }
      return expr;
    }
    // Expr ::= OrExpr
    parseExpr() {
      return this.parseOr();
    }
    parseBinaryLeft(subParse, opMap) {
      let left = subParse.call(this);
      for (; ; ) {
        const op = opMap[this.peek().type];
        if (!op) return left;
        this.next();
        const right = subParse.call(this);
        left = { type: "Binary", op, left, right };
      }
    }
    parseOr() {
      return this.parseBinaryLeft(this.parseAnd, OR_OPS);
    }
    parseAnd() {
      return this.parseBinaryLeft(this.parseEquality, AND_OPS);
    }
    parseEquality() {
      return this.parseBinaryLeft(this.parseRelational, EQUALITY_OPS);
    }
    parseRelational() {
      return this.parseBinaryLeft(this.parseAdditive, RELATIONAL_OPS);
    }
    parseAdditive() {
      return this.parseBinaryLeft(this.parseMultiplicative, ADDITIVE_OPS);
    }
    parseMultiplicative() {
      return this.parseBinaryLeft(this.parseUnary, MULTIPLICATIVE_OPS);
    }
    // UnaryExpr ::= UnionExpr | '-' UnaryExpr
    parseUnary() {
      if (this.is(T.MINUS)) {
        this.next();
        return { type: "Unary", operand: this.parseUnary() };
      }
      return this.parseUnion();
    }
    // UnionExpr ::= PathExpr ('|' PathExpr)*
    parseUnion() {
      let left = this.parsePathExpr();
      while (this.is(T.PIPE)) {
        this.next();
        const right = this.parsePathExpr();
        left = { type: "Binary", op: "union", left, right };
      }
      return left;
    }
    // PathExpr ::= LocationPath | FilterExpr (('/' | '//') RelativeLocationPath)?
    parsePathExpr() {
      if (PRIMARY_START.has(this.peek().type)) {
        const primary = this.parseFilterExpr();
        if (this.is(T.SLASH) || this.is(T.DOUBLESLASH)) {
          const steps = [];
          if (this.is(T.DOUBLESLASH)) steps.push(descendantOrSelfStep());
          this.next();
          this.parseRelativeSteps(steps);
          return { type: "Path", root: primary, steps };
        }
        return primary;
      }
      return this.parseLocationPath();
    }
    // LocationPath ::= RelativeLocationPath | AbsoluteLocationPath
    parseLocationPath() {
      if (this.is(T.SLASH)) {
        this.next();
        const steps2 = [];
        if (STEP_START.has(this.peek().type)) this.parseRelativeSteps(steps2);
        return { type: "Path", root: { type: "Root" }, steps: steps2 };
      }
      if (this.is(T.DOUBLESLASH)) {
        this.next();
        const steps2 = [descendantOrSelfStep()];
        this.parseRelativeSteps(steps2);
        return { type: "Path", root: { type: "Root" }, steps: steps2 };
      }
      const steps = [];
      this.parseRelativeSteps(steps);
      return { type: "Path", root: null, steps };
    }
    // RelativeLocationPath ::= Step (('/' | '//') Step)*
    parseRelativeSteps(steps) {
      steps.push(this.parseStep());
      for (; ; ) {
        if (this.is(T.SLASH)) {
          this.next();
          steps.push(this.parseStep());
        } else if (this.is(T.DOUBLESLASH)) {
          this.next();
          steps.push(descendantOrSelfStep());
          steps.push(this.parseStep());
        } else {
          return steps;
        }
      }
    }
    // Step ::= AxisSpecifier NodeTest Predicate* | AbbreviatedStep
    parseStep() {
      if (this.is(T.DOT)) {
        this.next();
        return nodeTypeStep("self", "node");
      }
      if (this.is(T.DOTDOT)) {
        this.next();
        return nodeTypeStep("parent", "node");
      }
      let axis = "child";
      if (this.is(T.AT)) {
        this.next();
        axis = "attribute";
      } else if (this.is(T.AXISNAME)) {
        const name = this.next().value;
        if (!AXES.has(name)) {
          throw new XPathSyntaxError(`unknown axis '${name}'`, this.tokens[this.pos - 1].pos);
        }
        this.expect(T.DOUBLECOLON);
        axis = name;
      }
      const nodeTest = this.parseNodeTest();
      const predicates = this.parsePredicates();
      return { type: "Step", axis, nodeTest, predicates };
    }
    // NodeTest ::= NameTest | NodeType '(' ')' | 'processing-instruction' '(' Literal ')'
    parseNodeTest() {
      if (this.is(T.NODETYPE)) {
        const name = this.next().value;
        this.expect(T.LPAREN);
        let literal = null;
        if (name === "processing-instruction" && this.is(T.LITERAL)) {
          literal = this.next().value;
        }
        this.expect(T.RPAREN);
        return { kind: "type", name, literal };
      }
      if (this.is(T.NAMETEST)) {
        const { prefix, local } = this.next().value;
        return { kind: "name", prefix, local };
      }
      const tok = this.peek();
      throw new XPathSyntaxError(`expected a node test but found ${tok.type}`, tok.pos);
    }
    // Predicate* ::= ('[' Expr ']')*
    parsePredicates() {
      const predicates = [];
      while (this.is(T.LBRACKET)) {
        this.next();
        predicates.push(this.parseExpr());
        this.expect(T.RBRACKET);
      }
      return predicates;
    }
    // FilterExpr ::= PrimaryExpr Predicate*
    parseFilterExpr() {
      const primary = this.parsePrimary();
      const predicates = this.parsePredicates();
      if (predicates.length === 0) return primary;
      return { type: "Filter", primary, predicates };
    }
    // PrimaryExpr ::= VariableReference | '(' Expr ')' | Literal | Number | FunctionCall
    parsePrimary() {
      const tok = this.peek();
      switch (tok.type) {
        case T.VARREF:
          throw new XPathSyntaxError(`variable references are not supported ($${tok.value})`, tok.pos);
        case T.LPAREN: {
          this.next();
          const expr = this.parseExpr();
          this.expect(T.RPAREN);
          return expr;
        }
        case T.LITERAL:
          this.next();
          return { type: "Literal", value: tok.value };
        case T.NUMBER:
          this.next();
          return { type: "Number", value: tok.value };
        case T.FUNCNAME:
          return this.parseFunctionCall();
        default:
          throw new XPathSyntaxError(`unexpected token ${tok.type}`, tok.pos);
      }
    }
    // FunctionCall ::= FunctionName '(' (Argument (',' Argument)*)? ')'
    parseFunctionCall() {
      const { prefix, local } = this.next().value;
      this.expect(T.LPAREN);
      const args = [];
      if (!this.is(T.RPAREN)) {
        args.push(this.parseExpr());
        while (this.is(T.COMMA)) {
          this.next();
          args.push(this.parseExpr());
        }
      }
      this.expect(T.RPAREN);
      return { type: "Function", prefix: prefix ?? null, name: local, args };
    }
  };
  function parse3(expr) {
    return new Parser(tokenize(expr)).parse();
  }
  __name(parse3, "parse");

  // node_modules/.pnpm/xpathway@1.0.0/node_modules/xpathway/src/types.js
  var NodeSet = class {
    static {
      __name(this, "NodeSet");
    }
    // A NodeSet takes ownership of `nodes`: ordered() sorts it in place, so the
    // caller must not retain or share the array. Pass `sorted: true` only when the
    // array is already in document order (e.g. a single forward-axis step).
    constructor(nodes = [], sorted = false) {
      this.nodes = nodes;
      this.sorted = sorted;
    }
    get size() {
      return this.nodes.length;
    }
    // Returns the nodes in document order, sorting in place on first need.
    ordered(adapter) {
      if (!this.sorted) {
        this.nodes.sort((a, b) => adapter.compareDocumentPosition(a, b));
        this.sorted = true;
      }
      return this.nodes;
    }
    // The first node in document order, or null for the empty set.
    first(adapter) {
      if (this.nodes.length === 0) return null;
      if (this.sorted) return this.nodes[0];
      let best = this.nodes[0];
      for (let i = 1; i < this.nodes.length; i++) {
        if (adapter.compareDocumentPosition(this.nodes[i], best) < 0) best = this.nodes[i];
      }
      return best;
    }
  };
  function isNodeSet(v) {
    return v instanceof NodeSet;
  }
  __name(isNodeSet, "isNodeSet");
  function toBoolean(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
    if (typeof value === "string") return value.length > 0;
    if (isNodeSet(value)) return value.size > 0;
    throw new XPathTypeError(`cannot convert ${describe(value)} to boolean`);
  }
  __name(toBoolean, "toBoolean");
  function toNumber(value, adapter) {
    if (typeof value === "number") return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "string") return stringToNumber(value);
    if (isNodeSet(value)) return stringToNumber(nodeSetString(value, adapter));
    throw new XPathTypeError(`cannot convert ${describe(value)} to number`);
  }
  __name(toNumber, "toNumber");
  function toStr(value, adapter) {
    if (typeof value === "string") return value;
    if (typeof value === "number") return numberToString(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    if (isNodeSet(value)) return nodeSetString(value, adapter);
    throw new XPathTypeError(`cannot convert ${describe(value)} to string`);
  }
  __name(toStr, "toStr");
  function nodeSetString(ns, adapter) {
    const node = ns.first(adapter);
    return node == null ? "" : adapter.stringValue(node);
  }
  __name(nodeSetString, "nodeSetString");
  function describe(value) {
    return value === null ? "null" : typeof value;
  }
  __name(describe, "describe");
  var XPATH_WS = /^[ \t\r\n]+|[ \t\r\n]+$/g;
  var NUMBER_RE = /^-?(\d+(\.\d*)?|\.\d+)$/;
  function stringToNumber(s) {
    const trimmed = s.replace(XPATH_WS, "");
    if (!NUMBER_RE.test(trimmed)) return NaN;
    return Number(trimmed);
  }
  __name(stringToNumber, "stringToNumber");
  function numberToString(n) {
    if (Number.isNaN(n)) return "NaN";
    if (n === Infinity) return "Infinity";
    if (n === -Infinity) return "-Infinity";
    if (n === 0) return "0";
    const s = String(n);
    if (s.indexOf("e") === -1 && s.indexOf("E") === -1) return s;
    return expandExponential(s);
  }
  __name(numberToString, "numberToString");
  function expandExponential(input) {
    let s = input;
    const negative = s[0] === "-";
    if (negative) s = s.slice(1);
    const [mantissa, expPart] = s.split(/[eE]/);
    const exp = Number(expPart);
    const [intPart, fracPart = ""] = mantissa.split(".");
    const digits = intPart + fracPart;
    const pointPos = intPart.length + exp;
    let result;
    if (pointPos <= 0) {
      result = `0.${"0".repeat(-pointPos)}${digits}`;
    } else if (pointPos >= digits.length) {
      result = digits + "0".repeat(pointPos - digits.length);
    } else {
      result = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
    }
    return negative ? `-${result}` : result;
  }
  __name(expandExponential, "expandExponential");

  // node_modules/.pnpm/xpathway@1.0.0/node_modules/xpathway/src/compare.js
  var EQ_TESTS = {
    "=": /* @__PURE__ */ __name((x, y) => x === y, "="),
    "!=": /* @__PURE__ */ __name((x, y) => x !== y, "!=")
  };
  var REL_TESTS = {
    "<": /* @__PURE__ */ __name((x, y) => x < y, "<"),
    "<=": /* @__PURE__ */ __name((x, y) => x <= y, "<="),
    ">": /* @__PURE__ */ __name((x, y) => x > y, ">"),
    ">=": /* @__PURE__ */ __name((x, y) => x >= y, ">=")
  };
  function compareEquality(op, a, b, adapter) {
    const test = EQ_TESTS[op];
    if (isNodeSet(a) && isNodeSet(b)) {
      const bStrings = b.nodes.map((n) => adapter.stringValue(n));
      for (const n of a.nodes) {
        const s = adapter.stringValue(n);
        for (const bs of bStrings) {
          if (test(s, bs)) return true;
        }
      }
      return false;
    }
    if (isNodeSet(a) || isNodeSet(b)) {
      const ns = isNodeSet(a) ? a : b;
      const other = isNodeSet(a) ? b : a;
      if (typeof other === "boolean") {
        return test(toBoolean(ns), other);
      }
      if (typeof other === "number") {
        for (const n of ns.nodes) {
          if (test(stringToNumber(adapter.stringValue(n)), other)) return true;
        }
        return false;
      }
      const str = String(other);
      for (const n of ns.nodes) {
        if (test(adapter.stringValue(n), str)) return true;
      }
      return false;
    }
    if (typeof a === "boolean" || typeof b === "boolean") {
      return test(toBoolean(a), toBoolean(b));
    }
    if (typeof a === "number" || typeof b === "number") {
      return test(toNumber(a, adapter), toNumber(b, adapter));
    }
    return test(toStr(a, adapter), toStr(b, adapter));
  }
  __name(compareEquality, "compareEquality");
  function compareRelational(op, a, b, adapter) {
    const test = REL_TESTS[op];
    const left = numericValues(a, adapter);
    const right = numericValues(b, adapter);
    for (const x of left) {
      for (const y of right) {
        if (test(x, y)) return true;
      }
    }
    return false;
  }
  __name(compareRelational, "compareRelational");
  function numericValues(value, adapter) {
    if (isNodeSet(value)) {
      return value.nodes.map((n) => stringToNumber(adapter.stringValue(n)));
    }
    return [toNumber(value, adapter)];
  }
  __name(numericValues, "numericValues");

  // node_modules/.pnpm/xpathway@1.0.0/node_modules/xpathway/src/node-types.js
  var ELEMENT = 1;
  var ATTRIBUTE = 2;
  var TEXT = 3;
  var PROCESSING_INSTRUCTION = 7;
  var COMMENT = 8;
  var DOCUMENT = 9;
  var XML_NS = "http://www.w3.org/XML/1998/namespace";
  var XHTML_NS = "http://www.w3.org/1999/xhtml";

  // node_modules/.pnpm/xpathway@1.0.0/node_modules/xpathway/src/axes.js
  function previousSibling(node, adapter) {
    if (adapter.previousSibling) return adapter.previousSibling(node);
    const parent = adapter.parent(node);
    if (!parent) return null;
    const kids = adapter.childNodes(parent);
    const i = kids.indexOf(node);
    return i > 0 ? kids[i - 1] : null;
  }
  __name(previousSibling, "previousSibling");
  function nextSibling(node, adapter) {
    if (adapter.nextSibling) return adapter.nextSibling(node);
    const parent = adapter.parent(node);
    if (!parent) return null;
    const kids = adapter.childNodes(parent);
    const i = kids.indexOf(node);
    return i >= 0 && i + 1 < kids.length ? kids[i + 1] : null;
  }
  __name(nextSibling, "nextSibling");
  function collectDescendants(node, adapter, out) {
    const stack = [];
    pushChildrenReversed(node, adapter, stack);
    while (stack.length) {
      const n = stack.pop();
      out.push(n);
      pushChildrenReversed(n, adapter, stack);
    }
    return out;
  }
  __name(collectDescendants, "collectDescendants");
  function pushChildrenReversed(node, adapter, stack) {
    const kids = adapter.childNodes(node);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  __name(pushChildrenReversed, "pushChildrenReversed");
  function ancestors(node, adapter) {
    const out = [];
    let p = adapter.parent(node);
    while (p) {
      out.push(p);
      p = adapter.parent(p);
    }
    return out;
  }
  __name(ancestors, "ancestors");
  var AXES2 = {
    self: /* @__PURE__ */ __name((node) => [node], "self"),
    child: /* @__PURE__ */ __name((node, adapter) => adapter.childNodes(node).slice(), "child"),
    parent: /* @__PURE__ */ __name((node, adapter) => {
      const p = adapter.parent(node);
      return p ? [p] : [];
    }, "parent"),
    descendant: /* @__PURE__ */ __name((node, adapter) => collectDescendants(node, adapter, []), "descendant"),
    "descendant-or-self": /* @__PURE__ */ __name((node, adapter) => collectDescendants(node, adapter, [node]), "descendant-or-self"),
    ancestor: /* @__PURE__ */ __name((node, adapter) => ancestors(node, adapter), "ancestor"),
    "ancestor-or-self": /* @__PURE__ */ __name((node, adapter) => [node, ...ancestors(node, adapter)], "ancestor-or-self"),
    "following-sibling": /* @__PURE__ */ __name((node, adapter) => {
      const out = [];
      for (let s = nextSibling(node, adapter); s; s = nextSibling(s, adapter)) out.push(s);
      return out;
    }, "following-sibling"),
    "preceding-sibling": /* @__PURE__ */ __name((node, adapter) => {
      const out = [];
      for (let s = previousSibling(node, adapter); s; s = previousSibling(s, adapter)) out.push(s);
      return out;
    }, "preceding-sibling"),
    following: /* @__PURE__ */ __name((node, adapter) => {
      const out = [];
      let cur = node;
      while (cur && adapter.nodeType(cur) !== DOCUMENT) {
        for (let s = nextSibling(cur, adapter); s; s = nextSibling(s, adapter)) {
          out.push(s);
          collectDescendants(s, adapter, out);
        }
        cur = adapter.parent(cur);
      }
      out.sort((a, b) => adapter.compareDocumentPosition(a, b));
      return out;
    }, "following"),
    preceding: /* @__PURE__ */ __name((node, adapter) => {
      const out = [];
      let cur = node;
      while (cur && adapter.nodeType(cur) !== DOCUMENT) {
        for (let s = previousSibling(cur, adapter); s; s = previousSibling(s, adapter)) {
          out.push(s);
          collectDescendants(s, adapter, out);
        }
        cur = adapter.parent(cur);
      }
      out.sort((a, b) => adapter.compareDocumentPosition(a, b));
      out.reverse();
      return out;
    }, "preceding"),
    attribute: /* @__PURE__ */ __name((node, adapter) => adapter.attributes(node).slice(), "attribute"),
    // Namespace nodes are not modeled by the target DOMs (§5/§12); the namespace
    // axis is always empty. The `namespace::` syntax still parses and evaluates.
    namespace: /* @__PURE__ */ __name(() => [], "namespace")
  };
  function axisNodes(axis, node, adapter) {
    const fn = AXES2[axis];
    if (!fn) throw new Error(`unsupported axis: ${axis}`);
    return fn(node, adapter);
  }
  __name(axisNodes, "axisNodes");

  // node_modules/.pnpm/xpathway@1.0.0/node_modules/xpathway/src/nodetest.js
  function principalType(axis) {
    return axis === "attribute" ? ATTRIBUTE : ELEMENT;
  }
  __name(principalType, "principalType");
  function asciiEqualsIgnoreCase(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      let ca = a.charCodeAt(i);
      let cb = b.charCodeAt(i);
      if (ca >= 65 && ca <= 90) ca += 32;
      if (cb >= 65 && cb <= 90) cb += 32;
      if (ca !== cb) return false;
    }
    return true;
  }
  __name(asciiEqualsIgnoreCase, "asciiEqualsIgnoreCase");
  function resolvePrefix(resolver, prefix) {
    if (prefix === "xml") return XML_NS;
    if (!resolver) return null;
    if (typeof resolver === "function") return resolver(prefix) ?? null;
    if (typeof resolver.lookupNamespaceURI === "function") {
      return resolver.lookupNamespaceURI(prefix) ?? null;
    }
    return null;
  }
  __name(resolvePrefix, "resolvePrefix");
  function matchesNodeTest(node, nodeTest, axis, adapter, resolver, html) {
    const type = adapter.nodeType(node);
    if (nodeTest.kind === "type") {
      switch (nodeTest.name) {
        case "node":
          return true;
        case "text":
          return type === TEXT;
        case "comment":
          return type === COMMENT;
        case "processing-instruction":
          if (type !== PROCESSING_INSTRUCTION) return false;
          return nodeTest.literal == null || adapter.nodeName(node) === nodeTest.literal;
        default:
          return false;
      }
    }
    if (axis === "namespace") return false;
    const principal = principalType(axis);
    if (type !== principal) return false;
    const local = adapter.localName(node);
    const ns = adapter.namespaceURI(node) ?? null;
    if (nodeTest.prefix == null) {
      if (nodeTest.local === "*") return true;
      if (html) {
        if (principal === ATTRIBUTE) {
          return ns == null && asciiEqualsIgnoreCase(local, nodeTest.local);
        }
        if (ns === XHTML_NS) return asciiEqualsIgnoreCase(local, nodeTest.local);
        return ns == null && local === nodeTest.local;
      }
      return ns == null && local === nodeTest.local;
    }
    const uri = resolvePrefix(resolver, nodeTest.prefix);
    if (uri == null) {
      throw new XPathTypeError(`unresolved namespace prefix '${nodeTest.prefix}'`);
    }
    if (nodeTest.local === "*") return ns === uri;
    return ns === uri && local === nodeTest.local;
  }
  __name(matchesNodeTest, "matchesNodeTest");
  function documentNodeOf(node, adapter) {
    return adapter.nodeType(node) === DOCUMENT ? node : adapter.ownerDocument(node);
  }
  __name(documentNodeOf, "documentNodeOf");
  function isHtmlDocument(node, adapter) {
    const doc = documentNodeOf(node, adapter);
    return doc ? !!adapter.isHtmlDocument(doc) : false;
  }
  __name(isHtmlDocument, "isHtmlDocument");

  // node_modules/.pnpm/xpathway@1.0.0/node_modules/xpathway/src/functions.js
  function arity(name, args, min, max = min) {
    if (args.length < min || args.length > max) {
      const range = min === max ? `${min}` : `${min}-${max}`;
      throw new XPathTypeError(`${name}() expects ${range} argument(s), got ${args.length}`);
    }
  }
  __name(arity, "arity");
  function requireNodeSet(name, value) {
    if (!isNodeSet(value)) {
      throw new XPathTypeError(`${name}() requires a node-set argument`);
    }
    return value;
  }
  __name(requireNodeSet, "requireNodeSet");
  function targetNode(name, ctx, args) {
    arity(name, args, 0, 1);
    if (args.length === 0) return ctx.node;
    return requireNodeSet(name, args[0]).first(ctx.adapter);
  }
  __name(targetNode, "targetNode");
  function targetString(name, ctx, args) {
    arity(name, args, 0, 1);
    if (args.length === 0) return ctx.adapter.stringValue(ctx.node);
    return toStr(args[0], ctx.adapter);
  }
  __name(targetString, "targetString");
  function xpathRound(x) {
    if (Number.isNaN(x) || x === Infinity || x === -Infinity) return x;
    return Math.floor(x + 0.5);
  }
  __name(xpathRound, "xpathRound");
  var WS_RUN = /[ \t\r\n]+/g;
  function splitWhitespace(s) {
    return s.split(WS_RUN).filter((t) => t.length > 0);
  }
  __name(splitWhitespace, "splitWhitespace");
  var coreFunctions = {
    // --- node-set (REC §4.1) -------------------------------------------------
    last: /* @__PURE__ */ __name((ctx, args) => {
      arity("last", args, 0);
      return ctx.size;
    }, "last"),
    position: /* @__PURE__ */ __name((ctx, args) => {
      arity("position", args, 0);
      return ctx.position;
    }, "position"),
    count: /* @__PURE__ */ __name((ctx, args) => {
      arity("count", args, 1);
      return requireNodeSet("count", args[0]).size;
    }, "count"),
    id: /* @__PURE__ */ __name((ctx, args) => {
      arity("id", args, 1);
      const { adapter } = ctx;
      const doc = documentNodeOf(ctx.node, adapter);
      let tokens;
      if (isNodeSet(args[0])) {
        tokens = args[0].nodes.flatMap((n) => splitWhitespace(adapter.stringValue(n)));
      } else {
        tokens = splitWhitespace(toStr(args[0], adapter));
      }
      const seen = /* @__PURE__ */ new Set();
      const nodes = [];
      for (const token of tokens) {
        const el = doc ? adapter.getElementById(doc, token) : null;
        if (el && !seen.has(el)) {
          seen.add(el);
          nodes.push(el);
        }
      }
      return new NodeSet(nodes, false);
    }, "id"),
    "local-name": /* @__PURE__ */ __name((ctx, args) => {
      const node = targetNode("local-name", ctx, args);
      if (node == null) return "";
      const type = ctx.adapter.nodeType(node);
      if (type === ELEMENT || type === ATTRIBUTE) return ctx.adapter.localName(node) ?? "";
      if (type === PROCESSING_INSTRUCTION) return ctx.adapter.nodeName(node) ?? "";
      return "";
    }, "local-name"),
    "namespace-uri": /* @__PURE__ */ __name((ctx, args) => {
      const node = targetNode("namespace-uri", ctx, args);
      if (node == null) return "";
      const type = ctx.adapter.nodeType(node);
      if (type === ELEMENT || type === ATTRIBUTE) return ctx.adapter.namespaceURI(node) ?? "";
      return "";
    }, "namespace-uri"),
    name: /* @__PURE__ */ __name((ctx, args) => {
      const node = targetNode("name", ctx, args);
      if (node == null) return "";
      const type = ctx.adapter.nodeType(node);
      if (type === ELEMENT || type === ATTRIBUTE || type === PROCESSING_INSTRUCTION) {
        return ctx.adapter.nodeName(node) ?? "";
      }
      return "";
    }, "name"),
    // --- string (REC §4.2) ---------------------------------------------------
    string: /* @__PURE__ */ __name((ctx, args) => targetString("string", ctx, args), "string"),
    concat: /* @__PURE__ */ __name((ctx, args) => {
      arity("concat", args, 2, Infinity);
      return args.map((a) => toStr(a, ctx.adapter)).join("");
    }, "concat"),
    "starts-with": /* @__PURE__ */ __name((ctx, args) => {
      arity("starts-with", args, 2);
      return toStr(args[0], ctx.adapter).startsWith(toStr(args[1], ctx.adapter));
    }, "starts-with"),
    contains: /* @__PURE__ */ __name((ctx, args) => {
      arity("contains", args, 2);
      return toStr(args[0], ctx.adapter).includes(toStr(args[1], ctx.adapter));
    }, "contains"),
    "substring-before": /* @__PURE__ */ __name((ctx, args) => {
      arity("substring-before", args, 2);
      const s = toStr(args[0], ctx.adapter);
      const sub = toStr(args[1], ctx.adapter);
      const i = s.indexOf(sub);
      return i === -1 ? "" : s.slice(0, i);
    }, "substring-before"),
    "substring-after": /* @__PURE__ */ __name((ctx, args) => {
      arity("substring-after", args, 2);
      const s = toStr(args[0], ctx.adapter);
      const sub = toStr(args[1], ctx.adapter);
      const i = s.indexOf(sub);
      return i === -1 ? "" : s.slice(i + sub.length);
    }, "substring-after"),
    substring: /* @__PURE__ */ __name((ctx, args) => {
      arity("substring", args, 2, 3);
      const s = toStr(args[0], ctx.adapter);
      const lo = xpathRound(toNumber(args[1], ctx.adapter));
      const hi = args.length === 3 ? lo + xpathRound(toNumber(args[2], ctx.adapter)) : Infinity;
      let out = "";
      for (let i = 0; i < s.length; i++) {
        const p = i + 1;
        if (p >= lo && p < hi) out += s[i];
      }
      return out;
    }, "substring"),
    "string-length": /* @__PURE__ */ __name((ctx, args) => targetString("string-length", ctx, args).length, "string-length"),
    "normalize-space": /* @__PURE__ */ __name((ctx, args) => targetString("normalize-space", ctx, args).replace(WS_RUN, " ").replace(/^ | $/g, ""), "normalize-space"),
    translate: /* @__PURE__ */ __name((ctx, args) => {
      arity("translate", args, 3);
      const s = toStr(args[0], ctx.adapter);
      const from = toStr(args[1], ctx.adapter);
      const to = toStr(args[2], ctx.adapter);
      let out = "";
      for (let i = 0; i < s.length; i++) {
        const j = from.indexOf(s[i]);
        if (j === -1) out += s[i];
        else if (j < to.length) out += to[j];
      }
      return out;
    }, "translate"),
    // --- boolean (REC §4.3) --------------------------------------------------
    boolean: /* @__PURE__ */ __name((ctx, args) => {
      arity("boolean", args, 1);
      return toBoolean(args[0]);
    }, "boolean"),
    not: /* @__PURE__ */ __name((ctx, args) => {
      arity("not", args, 1);
      return !toBoolean(args[0]);
    }, "not"),
    true: /* @__PURE__ */ __name((ctx, args) => {
      arity("true", args, 0);
      return true;
    }, "true"),
    false: /* @__PURE__ */ __name((ctx, args) => {
      arity("false", args, 0);
      return false;
    }, "false"),
    lang: /* @__PURE__ */ __name((ctx, args) => {
      arity("lang", args, 1);
      const { adapter } = ctx;
      const target = toStr(args[0], adapter).toLowerCase();
      let lang = null;
      for (let node = ctx.node; node; node = adapter.parent(node)) {
        if (adapter.nodeType(node) === ELEMENT) {
          const value = adapter.getAttribute(node, XML_NS, "lang");
          if (value != null) {
            lang = value.toLowerCase();
            break;
          }
        }
      }
      if (lang == null) return false;
      return lang === target || lang.startsWith(`${target}-`);
    }, "lang"),
    // --- number (REC §4.4) ---------------------------------------------------
    number: /* @__PURE__ */ __name((ctx, args) => {
      arity("number", args, 0, 1);
      if (args.length === 0) return stringToNumber(ctx.adapter.stringValue(ctx.node));
      return toNumber(args[0], ctx.adapter);
    }, "number"),
    sum: /* @__PURE__ */ __name((ctx, args) => {
      arity("sum", args, 1);
      const ns = requireNodeSet("sum", args[0]);
      let total = 0;
      for (const node of ns.nodes) total += stringToNumber(ctx.adapter.stringValue(node));
      return total;
    }, "sum"),
    floor: /* @__PURE__ */ __name((ctx, args) => {
      arity("floor", args, 1);
      return Math.floor(toNumber(args[0], ctx.adapter));
    }, "floor"),
    ceiling: /* @__PURE__ */ __name((ctx, args) => {
      arity("ceiling", args, 1);
      return Math.ceil(toNumber(args[0], ctx.adapter));
    }, "ceiling"),
    round: /* @__PURE__ */ __name((ctx, args) => {
      arity("round", args, 1);
      return xpathRound(toNumber(args[0], ctx.adapter));
    }, "round")
  };

  // node_modules/.pnpm/xpathway@1.0.0/node_modules/xpathway/src/context.js
  function makeRootContext(node, adapter, { resolver = null, functions = coreFunctions } = {}) {
    return { node, position: 1, size: 1, adapter, resolver, functions, cache: /* @__PURE__ */ new Map() };
  }
  __name(makeRootContext, "makeRootContext");
  function withNode(ctx, node, position, size) {
    return {
      node,
      position,
      size,
      adapter: ctx.adapter,
      resolver: ctx.resolver,
      functions: ctx.functions,
      cache: ctx.cache
    };
  }
  __name(withNode, "withNode");

  // node_modules/.pnpm/xpathway@1.0.0/node_modules/xpathway/src/evaluate.js
  function evaluate(ast, ctx) {
    switch (ast.type) {
      case "Literal":
        return ast.value;
      case "Number":
        return ast.value;
      case "Unary":
        return -toNumber(evaluate(ast.operand, ctx), ctx.adapter);
      case "Binary":
        return evaluateBinary(ast, ctx);
      case "Path":
        return evaluatePath(ast, ctx);
      case "Filter":
        return evaluateFilter(ast, ctx);
      case "Function":
        return evaluateFunction(ast, ctx);
      default:
        throw new XPathTypeError(`unknown AST node type '${ast.type}'`);
    }
  }
  __name(evaluate, "evaluate");
  var ARITHMETIC = {
    "+": /* @__PURE__ */ __name((a, b) => a + b, "+"),
    "-": /* @__PURE__ */ __name((a, b) => a - b, "-"),
    "*": /* @__PURE__ */ __name((a, b) => a * b, "*"),
    "div": /* @__PURE__ */ __name((a, b) => a / b, "div"),
    // XPath `mod` is a truncating remainder, which is exactly JS `%`.
    "mod": /* @__PURE__ */ __name((a, b) => a % b, "mod")
  };
  function evaluateBinary(ast, ctx) {
    const { op } = ast;
    if (op === "or") {
      return toBoolean(evaluate(ast.left, ctx)) || toBoolean(evaluate(ast.right, ctx));
    }
    if (op === "and") {
      return toBoolean(evaluate(ast.left, ctx)) && toBoolean(evaluate(ast.right, ctx));
    }
    if (op === "union") {
      const left2 = evaluate(ast.left, ctx);
      const right2 = evaluate(ast.right, ctx);
      if (!isNodeSet(left2) || !isNodeSet(right2)) {
        throw new XPathTypeError("union operand is not a node-set");
      }
      return unionNodeSets(left2, right2);
    }
    const left = evaluate(ast.left, ctx);
    const right = evaluate(ast.right, ctx);
    if (op === "=" || op === "!=") {
      return compareEquality(op, left, right, ctx.adapter);
    }
    if (op === "<" || op === "<=" || op === ">" || op === ">=") {
      return compareRelational(op, left, right, ctx.adapter);
    }
    const arith = ARITHMETIC[op];
    return arith(toNumber(left, ctx.adapter), toNumber(right, ctx.adapter));
  }
  __name(evaluateBinary, "evaluateBinary");
  function unionNodeSets(a, b) {
    const seen = new Set(a.nodes);
    const nodes = a.nodes.slice();
    for (const n of b.nodes) {
      if (!seen.has(n)) {
        seen.add(n);
        nodes.push(n);
      }
    }
    return new NodeSet(nodes, false);
  }
  __name(unionNodeSets, "unionNodeSets");
  function evaluatePath(ast, ctx) {
    const { adapter } = ctx;
    const absolute = ast.root != null && ast.root.type === "Root";
    const doc = absolute ? documentNodeOf(ctx.node, adapter) : null;
    if (absolute) {
      const cached = ctx.cache.get(ast);
      if (cached && cached.doc === doc) return cached.value;
    }
    const html = isHtmlDocument(ctx.node, adapter);
    let current;
    if (ast.root == null) {
      current = [ctx.node];
    } else if (absolute) {
      current = doc ? [doc] : [];
    } else {
      const value = evaluate(ast.root, ctx);
      if (!isNodeSet(value)) {
        throw new XPathTypeError("the left-hand side of a path step is not a node-set");
      }
      current = value.nodes.slice();
    }
    for (const step of ast.steps) {
      current = evaluateStep(step, current, ctx, html);
    }
    const result = new NodeSet(current, false);
    if (absolute) ctx.cache.set(ast, { doc, value: result });
    return result;
  }
  __name(evaluatePath, "evaluatePath");
  var DISJOINT_AXES = /* @__PURE__ */ new Set(["self", "child", "attribute", "namespace"]);
  function evaluateStep(step, inputNodes, ctx, html) {
    const { adapter } = ctx;
    const out = [];
    const seen = inputNodes.length > 1 && !DISJOINT_AXES.has(step.axis) ? /* @__PURE__ */ new Set() : null;
    const test = step.nodeTest;
    const matchesAll = test.kind === "type" && test.name === "node";
    for (const node of inputNodes) {
      let candidates = axisNodes(step.axis, node, adapter);
      if (!matchesAll) {
        candidates = candidates.filter((n) => matchesNodeTest(n, test, step.axis, adapter, ctx.resolver, html));
      }
      candidates = applyPredicates(candidates, step.predicates, ctx);
      if (seen) {
        for (const n of candidates) {
          if (!seen.has(n)) {
            seen.add(n);
            out.push(n);
          }
        }
      } else {
        for (const n of candidates) out.push(n);
      }
    }
    return out;
  }
  __name(evaluateStep, "evaluateStep");
  function applyPredicates(nodes, predicates, ctx) {
    let current = nodes;
    for (const predicate of predicates) {
      const size = current.length;
      const kept = [];
      for (let i = 0; i < current.length; i++) {
        const position = i + 1;
        const value = evaluate(predicate, withNode(ctx, current[i], position, size));
        const keep = typeof value === "number" ? value === position : toBoolean(value);
        if (keep) kept.push(current[i]);
      }
      current = kept;
    }
    return current;
  }
  __name(applyPredicates, "applyPredicates");
  function evaluateFilter(ast, ctx) {
    const value = evaluate(ast.primary, ctx);
    if (!isNodeSet(value)) {
      throw new XPathTypeError("predicate applied to a non-node-set value");
    }
    const ordered = value.ordered(ctx.adapter).slice();
    return new NodeSet(applyPredicates(ordered, ast.predicates, ctx), true);
  }
  __name(evaluateFilter, "evaluateFilter");
  function evaluateFunction(ast, ctx) {
    if (ast.prefix) {
      throw new XPathTypeError(`unknown function: ${ast.prefix}:${ast.name}()`);
    }
    const fn = ctx.functions && ctx.functions[ast.name];
    if (!fn) {
      throw new XPathTypeError(`unknown function: ${ast.name}()`);
    }
    const args = ast.args.map((arg) => evaluate(arg, ctx));
    return fn(ctx, args);
  }
  __name(evaluateFunction, "evaluateFunction");

  // node_modules/.pnpm/xpathway@1.0.0/node_modules/xpathway/src/api.js
  var ANY_TYPE = 0;
  var NUMBER_TYPE = 1;
  var STRING_TYPE = 2;
  var BOOLEAN_TYPE = 3;
  var UNORDERED_NODE_ITERATOR_TYPE = 4;
  var ORDERED_NODE_ITERATOR_TYPE = 5;
  var UNORDERED_NODE_SNAPSHOT_TYPE = 6;
  var ORDERED_NODE_SNAPSHOT_TYPE = 7;
  var ANY_UNORDERED_NODE_TYPE = 8;
  var FIRST_ORDERED_NODE_TYPE = 9;
  var ITERATOR_TYPES = /* @__PURE__ */ new Set([UNORDERED_NODE_ITERATOR_TYPE, ORDERED_NODE_ITERATOR_TYPE]);
  var SNAPSHOT_TYPES = /* @__PURE__ */ new Set([UNORDERED_NODE_SNAPSHOT_TYPE, ORDERED_NODE_SNAPSHOT_TYPE]);
  var SINGLE_TYPES = /* @__PURE__ */ new Set([ANY_UNORDERED_NODE_TYPE, FIRST_ORDERED_NODE_TYPE]);
  var NODE_TYPES2 = /* @__PURE__ */ new Set([
    ...ITERATOR_TYPES,
    ...SNAPSHOT_TYPES,
    ...SINGLE_TYPES
  ]);
  function naturalType(value) {
    if (isNodeSet(value)) return UNORDERED_NODE_ITERATOR_TYPE;
    if (typeof value === "boolean") return BOOLEAN_TYPE;
    if (typeof value === "number") return NUMBER_TYPE;
    return STRING_TYPE;
  }
  __name(naturalType, "naturalType");
  var XPathResult = class {
    static {
      __name(this, "XPathResult");
    }
    constructor(value, requestedType, adapter, exceptions) {
      this._exceptions = exceptions;
      const type = requestedType === ANY_TYPE ? naturalType(value) : requestedType;
      this._type = type;
      if (NODE_TYPES2.has(type)) {
        if (!isNodeSet(value)) {
          throw exceptions.typeError("result cannot be converted to the requested node-set type");
        }
        const nodes = value.ordered(adapter);
        if (ITERATOR_TYPES.has(type)) {
          this._nodes = nodes.slice();
          this._index = 0;
        } else if (SNAPSHOT_TYPES.has(type)) {
          this._snapshot = nodes.slice();
        } else {
          this._single = nodes.length > 0 ? nodes[0] : null;
        }
      } else if (type === NUMBER_TYPE) {
        this._number = toNumber(value, adapter);
      } else if (type === STRING_TYPE) {
        this._string = toStr(value, adapter);
      } else if (type === BOOLEAN_TYPE) {
        this._boolean = toBoolean(value);
      } else {
        throw exceptions.typeError(`unknown XPathResult type: ${type}`);
      }
    }
    _wrongType(what) {
      return this._exceptions.typeError(`${what} is not available for result type ${this._type}`);
    }
    get resultType() {
      return this._type;
    }
    get numberValue() {
      if (this._type !== NUMBER_TYPE) throw this._wrongType("numberValue");
      return this._number;
    }
    get stringValue() {
      if (this._type !== STRING_TYPE) throw this._wrongType("stringValue");
      return this._string;
    }
    get booleanValue() {
      if (this._type !== BOOLEAN_TYPE) throw this._wrongType("booleanValue");
      return this._boolean;
    }
    get singleNodeValue() {
      if (!SINGLE_TYPES.has(this._type)) throw this._wrongType("singleNodeValue");
      return this._single;
    }
    get snapshotLength() {
      if (!SNAPSHOT_TYPES.has(this._type)) throw this._wrongType("snapshotLength");
      return this._snapshot.length;
    }
    get invalidIteratorState() {
      if (!ITERATOR_TYPES.has(this._type)) throw this._wrongType("invalidIteratorState");
      return false;
    }
    iterateNext() {
      if (!ITERATOR_TYPES.has(this._type)) throw this._wrongType("iterateNext()");
      if (this._index >= this._nodes.length) return null;
      return this._nodes[this._index++];
    }
    snapshotItem(index) {
      if (!SNAPSHOT_TYPES.has(this._type)) throw this._wrongType("snapshotItem()");
      return index >= 0 && index < this._snapshot.length ? this._snapshot[index] : null;
    }
  };
  var RESULT_CONSTANTS = {
    ANY_TYPE,
    NUMBER_TYPE,
    STRING_TYPE,
    BOOLEAN_TYPE,
    UNORDERED_NODE_ITERATOR_TYPE,
    ORDERED_NODE_ITERATOR_TYPE,
    UNORDERED_NODE_SNAPSHOT_TYPE,
    ORDERED_NODE_SNAPSHOT_TYPE,
    ANY_UNORDERED_NODE_TYPE,
    FIRST_ORDERED_NODE_TYPE
  };
  for (const [name, val] of Object.entries(RESULT_CONSTANTS)) {
    XPathResult[name] = val;
    XPathResult.prototype[name] = val;
  }
  var ParseCache = class {
    static {
      __name(this, "ParseCache");
    }
    constructor(limit) {
      this.limit = limit;
      this.map = /* @__PURE__ */ new Map();
    }
    get(expression) {
      if (this.map.has(expression)) {
        const ast2 = this.map.get(expression);
        this.map.delete(expression);
        this.map.set(expression, ast2);
        return ast2;
      }
      const ast = parse3(expression);
      this.map.set(expression, ast);
      if (this.map.size > this.limit) {
        this.map.delete(this.map.keys().next().value);
      }
      return ast;
    }
  };
  function memoizingAdapter(adapter) {
    const memo = /* @__PURE__ */ new Map();
    const wrapper = Object.create(adapter);
    wrapper.stringValue = (node) => {
      if (memo.has(node)) return memo.get(node);
      const value = adapter.stringValue(node);
      memo.set(node, value);
      return value;
    };
    return wrapper;
  }
  __name(memoizingAdapter, "memoizingAdapter");
  function defaultExceptions() {
    return {
      // Native SyntaxError already reports name === 'SyntaxError'.
      syntaxError: /* @__PURE__ */ __name((message) => new SyntaxError(message), "syntaxError"),
      typeError: /* @__PURE__ */ __name((message) => new TypeError(message), "typeError")
    };
  }
  __name(defaultExceptions, "defaultExceptions");
  function normalizeExceptions(provided) {
    const fallback = defaultExceptions();
    if (!provided) return fallback;
    return {
      syntaxError: provided.syntaxError ?? fallback.syntaxError,
      typeError: provided.typeError ?? fallback.typeError
    };
  }
  __name(normalizeExceptions, "normalizeExceptions");
  function mapError(error, exceptions) {
    if (error instanceof XPathSyntaxError) return exceptions.syntaxError(error.message);
    if (error instanceof XPathTypeError) return exceptions.typeError(error.message);
    return error;
  }
  __name(mapError, "mapError");
  var XPathExpression = class {
    static {
      __name(this, "XPathExpression");
    }
    constructor(ast, resolver, adapter, exceptions) {
      this._ast = ast;
      this._resolver = resolver ?? null;
      this._adapter = adapter;
      this._exceptions = exceptions;
    }
    // `result` (DOM's reuse-an-existing-XPathResult argument) is accepted for
    // signature parity but ignored — a fresh XPathResult is always returned.
    evaluate(contextNode, resultType = ANY_TYPE, result = null) {
      const adapter = memoizingAdapter(this._adapter);
      const ctx = makeRootContext(contextNode, adapter, { resolver: this._resolver });
      let value;
      try {
        value = evaluate(this._ast, ctx);
      } catch (error) {
        throw mapError(error, this._exceptions);
      }
      return new XPathResult(value, resultType, adapter, this._exceptions);
    }
  };
  function makeNSResolver(node, adapter) {
    return {
      lookupNamespaceURI(prefix) {
        if (prefix === "xml") return XML_NS;
        const wanted = prefix ? `xmlns:${prefix}` : "xmlns";
        for (let n = node; n; n = adapter.parent(n)) {
          if (adapter.nodeType(n) !== ELEMENT) continue;
          for (const attr of adapter.attributes(n)) {
            if (adapter.nodeName(attr) === wanted) return adapter.stringValue(attr);
          }
        }
        return null;
      }
    };
  }
  __name(makeNSResolver, "makeNSResolver");
  function createEvaluator(adapter, options = {}) {
    const exceptions = normalizeExceptions(options.exceptions);
    const cache = new ParseCache(options.cacheSize ?? 1e3);
    function compile3(expression, resolver) {
      let ast;
      try {
        ast = cache.get(expression);
      } catch (error) {
        throw mapError(error, exceptions);
      }
      return new XPathExpression(ast, resolver ?? null, adapter, exceptions);
    }
    __name(compile3, "compile");
    return {
      evaluate(expression, contextNode, resolver, resultType = ANY_TYPE, result = null) {
        return compile3(expression, resolver).evaluate(contextNode, resultType, result);
      },
      createExpression(expression, resolver) {
        return compile3(expression, resolver);
      },
      createNSResolver(node) {
        return makeNSResolver(node, adapter);
      }
    };
  }
  __name(createEvaluator, "createEvaluator");
  return __toCommonJS(vendor_entry_exports);
})();
