var __csimVendor = (() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __export = (target, all) => {
    for (var name50 in all)
      __defProp(target, name50, { get: all[name50], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // node_modules/.pnpm/source-map-js@1.2.1/node_modules/source-map-js/lib/base64.js
  var require_base64 = __commonJS({
    "node_modules/.pnpm/source-map-js@1.2.1/node_modules/source-map-js/lib/base64.js"(exports) {
      var intToCharMap = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("");
      exports.encode = function(number) {
        if (0 <= number && number < intToCharMap.length) {
          return intToCharMap[number];
        }
        throw new TypeError("Must be between 0 and 63: " + number);
      };
      exports.decode = function(charCode) {
        var bigA = 65;
        var bigZ = 90;
        var littleA = 97;
        var littleZ = 122;
        var zero = 48;
        var nine = 57;
        var plus = 43;
        var slash = 47;
        var littleOffset = 26;
        var numberOffset = 52;
        if (bigA <= charCode && charCode <= bigZ) {
          return charCode - bigA;
        }
        if (littleA <= charCode && charCode <= littleZ) {
          return charCode - littleA + littleOffset;
        }
        if (zero <= charCode && charCode <= nine) {
          return charCode - zero + numberOffset;
        }
        if (charCode == plus) {
          return 62;
        }
        if (charCode == slash) {
          return 63;
        }
        return -1;
      };
    }
  });

  // node_modules/.pnpm/source-map-js@1.2.1/node_modules/source-map-js/lib/base64-vlq.js
  var require_base64_vlq = __commonJS({
    "node_modules/.pnpm/source-map-js@1.2.1/node_modules/source-map-js/lib/base64-vlq.js"(exports) {
      var base64 = require_base64();
      var VLQ_BASE_SHIFT = 5;
      var VLQ_BASE = 1 << VLQ_BASE_SHIFT;
      var VLQ_BASE_MASK = VLQ_BASE - 1;
      var VLQ_CONTINUATION_BIT = VLQ_BASE;
      function toVLQSigned(aValue) {
        return aValue < 0 ? (-aValue << 1) + 1 : (aValue << 1) + 0;
      }
      __name(toVLQSigned, "toVLQSigned");
      function fromVLQSigned(aValue) {
        var isNegative = (aValue & 1) === 1;
        var shifted = aValue >> 1;
        return isNegative ? -shifted : shifted;
      }
      __name(fromVLQSigned, "fromVLQSigned");
      exports.encode = /* @__PURE__ */ __name(function base64VLQ_encode(aValue) {
        var encoded = "";
        var digit;
        var vlq = toVLQSigned(aValue);
        do {
          digit = vlq & VLQ_BASE_MASK;
          vlq >>>= VLQ_BASE_SHIFT;
          if (vlq > 0) {
            digit |= VLQ_CONTINUATION_BIT;
          }
          encoded += base64.encode(digit);
        } while (vlq > 0);
        return encoded;
      }, "base64VLQ_encode");
      exports.decode = /* @__PURE__ */ __name(function base64VLQ_decode(aStr, aIndex, aOutParam) {
        var strLen = aStr.length;
        var result = 0;
        var shift = 0;
        var continuation, digit;
        do {
          if (aIndex >= strLen) {
            throw new Error("Expected more digits in base 64 VLQ value.");
          }
          digit = base64.decode(aStr.charCodeAt(aIndex++));
          if (digit === -1) {
            throw new Error("Invalid base64 digit: " + aStr.charAt(aIndex - 1));
          }
          continuation = !!(digit & VLQ_CONTINUATION_BIT);
          digit &= VLQ_BASE_MASK;
          result = result + (digit << shift);
          shift += VLQ_BASE_SHIFT;
        } while (continuation);
        aOutParam.value = fromVLQSigned(result);
        aOutParam.rest = aIndex;
      }, "base64VLQ_decode");
    }
  });

  // node_modules/.pnpm/source-map-js@1.2.1/node_modules/source-map-js/lib/util.js
  var require_util = __commonJS({
    "node_modules/.pnpm/source-map-js@1.2.1/node_modules/source-map-js/lib/util.js"(exports) {
      function getArg(aArgs, aName, aDefaultValue) {
        if (aName in aArgs) {
          return aArgs[aName];
        } else if (arguments.length === 3) {
          return aDefaultValue;
        } else {
          throw new Error('"' + aName + '" is a required argument.');
        }
      }
      __name(getArg, "getArg");
      exports.getArg = getArg;
      var urlRegexp = /^(?:([\w+\-.]+):)?\/\/(?:(\w+:\w+)@)?([\w.-]*)(?::(\d+))?(.*)$/;
      var dataUrlRegexp = /^data:.+\,.+$/;
      function urlParse(aUrl) {
        var match = aUrl.match(urlRegexp);
        if (!match) {
          return null;
        }
        return {
          scheme: match[1],
          auth: match[2],
          host: match[3],
          port: match[4],
          path: match[5]
        };
      }
      __name(urlParse, "urlParse");
      exports.urlParse = urlParse;
      function urlGenerate(aParsedUrl) {
        var url = "";
        if (aParsedUrl.scheme) {
          url += aParsedUrl.scheme + ":";
        }
        url += "//";
        if (aParsedUrl.auth) {
          url += aParsedUrl.auth + "@";
        }
        if (aParsedUrl.host) {
          url += aParsedUrl.host;
        }
        if (aParsedUrl.port) {
          url += ":" + aParsedUrl.port;
        }
        if (aParsedUrl.path) {
          url += aParsedUrl.path;
        }
        return url;
      }
      __name(urlGenerate, "urlGenerate");
      exports.urlGenerate = urlGenerate;
      var MAX_CACHED_INPUTS = 32;
      function lruMemoize(f) {
        var cache = [];
        return function(input) {
          for (var i = 0; i < cache.length; i++) {
            if (cache[i].input === input) {
              var temp = cache[0];
              cache[0] = cache[i];
              cache[i] = temp;
              return cache[0].result;
            }
          }
          var result = f(input);
          cache.unshift({
            input,
            result
          });
          if (cache.length > MAX_CACHED_INPUTS) {
            cache.pop();
          }
          return result;
        };
      }
      __name(lruMemoize, "lruMemoize");
      var normalize = lruMemoize(/* @__PURE__ */ __name(function normalize2(aPath) {
        var path = aPath;
        var url = urlParse(aPath);
        if (url) {
          if (!url.path) {
            return aPath;
          }
          path = url.path;
        }
        var isAbsolute = exports.isAbsolute(path);
        var parts = [];
        var start = 0;
        var i = 0;
        while (true) {
          start = i;
          i = path.indexOf("/", start);
          if (i === -1) {
            parts.push(path.slice(start));
            break;
          } else {
            parts.push(path.slice(start, i));
            while (i < path.length && path[i] === "/") {
              i++;
            }
          }
        }
        for (var part, up = 0, i = parts.length - 1; i >= 0; i--) {
          part = parts[i];
          if (part === ".") {
            parts.splice(i, 1);
          } else if (part === "..") {
            up++;
          } else if (up > 0) {
            if (part === "") {
              parts.splice(i + 1, up);
              up = 0;
            } else {
              parts.splice(i, 2);
              up--;
            }
          }
        }
        path = parts.join("/");
        if (path === "") {
          path = isAbsolute ? "/" : ".";
        }
        if (url) {
          url.path = path;
          return urlGenerate(url);
        }
        return path;
      }, "normalize"));
      exports.normalize = normalize;
      function join(aRoot, aPath) {
        if (aRoot === "") {
          aRoot = ".";
        }
        if (aPath === "") {
          aPath = ".";
        }
        var aPathUrl = urlParse(aPath);
        var aRootUrl = urlParse(aRoot);
        if (aRootUrl) {
          aRoot = aRootUrl.path || "/";
        }
        if (aPathUrl && !aPathUrl.scheme) {
          if (aRootUrl) {
            aPathUrl.scheme = aRootUrl.scheme;
          }
          return urlGenerate(aPathUrl);
        }
        if (aPathUrl || aPath.match(dataUrlRegexp)) {
          return aPath;
        }
        if (aRootUrl && !aRootUrl.host && !aRootUrl.path) {
          aRootUrl.host = aPath;
          return urlGenerate(aRootUrl);
        }
        var joined = aPath.charAt(0) === "/" ? aPath : normalize(aRoot.replace(/\/+$/, "") + "/" + aPath);
        if (aRootUrl) {
          aRootUrl.path = joined;
          return urlGenerate(aRootUrl);
        }
        return joined;
      }
      __name(join, "join");
      exports.join = join;
      exports.isAbsolute = function(aPath) {
        return aPath.charAt(0) === "/" || urlRegexp.test(aPath);
      };
      function relative(aRoot, aPath) {
        if (aRoot === "") {
          aRoot = ".";
        }
        aRoot = aRoot.replace(/\/$/, "");
        var level = 0;
        while (aPath.indexOf(aRoot + "/") !== 0) {
          var index = aRoot.lastIndexOf("/");
          if (index < 0) {
            return aPath;
          }
          aRoot = aRoot.slice(0, index);
          if (aRoot.match(/^([^\/]+:\/)?\/*$/)) {
            return aPath;
          }
          ++level;
        }
        return Array(level + 1).join("../") + aPath.substr(aRoot.length + 1);
      }
      __name(relative, "relative");
      exports.relative = relative;
      var supportsNullProto = (function() {
        var obj = /* @__PURE__ */ Object.create(null);
        return !("__proto__" in obj);
      })();
      function identity(s) {
        return s;
      }
      __name(identity, "identity");
      function toSetString(aStr) {
        if (isProtoString(aStr)) {
          return "$" + aStr;
        }
        return aStr;
      }
      __name(toSetString, "toSetString");
      exports.toSetString = supportsNullProto ? identity : toSetString;
      function fromSetString(aStr) {
        if (isProtoString(aStr)) {
          return aStr.slice(1);
        }
        return aStr;
      }
      __name(fromSetString, "fromSetString");
      exports.fromSetString = supportsNullProto ? identity : fromSetString;
      function isProtoString(s) {
        if (!s) {
          return false;
        }
        var length = s.length;
        if (length < 9) {
          return false;
        }
        if (s.charCodeAt(length - 1) !== 95 || s.charCodeAt(length - 2) !== 95 || s.charCodeAt(length - 3) !== 111 || s.charCodeAt(length - 4) !== 116 || s.charCodeAt(length - 5) !== 111 || s.charCodeAt(length - 6) !== 114 || s.charCodeAt(length - 7) !== 112 || s.charCodeAt(length - 8) !== 95 || s.charCodeAt(length - 9) !== 95) {
          return false;
        }
        for (var i = length - 10; i >= 0; i--) {
          if (s.charCodeAt(i) !== 36) {
            return false;
          }
        }
        return true;
      }
      __name(isProtoString, "isProtoString");
      function compareByOriginalPositions(mappingA, mappingB, onlyCompareOriginal) {
        var cmp = strcmp(mappingA.source, mappingB.source);
        if (cmp !== 0) {
          return cmp;
        }
        cmp = mappingA.originalLine - mappingB.originalLine;
        if (cmp !== 0) {
          return cmp;
        }
        cmp = mappingA.originalColumn - mappingB.originalColumn;
        if (cmp !== 0 || onlyCompareOriginal) {
          return cmp;
        }
        cmp = mappingA.generatedColumn - mappingB.generatedColumn;
        if (cmp !== 0) {
          return cmp;
        }
        cmp = mappingA.generatedLine - mappingB.generatedLine;
        if (cmp !== 0) {
          return cmp;
        }
        return strcmp(mappingA.name, mappingB.name);
      }
      __name(compareByOriginalPositions, "compareByOriginalPositions");
      exports.compareByOriginalPositions = compareByOriginalPositions;
      function compareByOriginalPositionsNoSource(mappingA, mappingB, onlyCompareOriginal) {
        var cmp;
        cmp = mappingA.originalLine - mappingB.originalLine;
        if (cmp !== 0) {
          return cmp;
        }
        cmp = mappingA.originalColumn - mappingB.originalColumn;
        if (cmp !== 0 || onlyCompareOriginal) {
          return cmp;
        }
        cmp = mappingA.generatedColumn - mappingB.generatedColumn;
        if (cmp !== 0) {
          return cmp;
        }
        cmp = mappingA.generatedLine - mappingB.generatedLine;
        if (cmp !== 0) {
          return cmp;
        }
        return strcmp(mappingA.name, mappingB.name);
      }
      __name(compareByOriginalPositionsNoSource, "compareByOriginalPositionsNoSource");
      exports.compareByOriginalPositionsNoSource = compareByOriginalPositionsNoSource;
      function compareByGeneratedPositionsDeflated(mappingA, mappingB, onlyCompareGenerated) {
        var cmp = mappingA.generatedLine - mappingB.generatedLine;
        if (cmp !== 0) {
          return cmp;
        }
        cmp = mappingA.generatedColumn - mappingB.generatedColumn;
        if (cmp !== 0 || onlyCompareGenerated) {
          return cmp;
        }
        cmp = strcmp(mappingA.source, mappingB.source);
        if (cmp !== 0) {
          return cmp;
        }
        cmp = mappingA.originalLine - mappingB.originalLine;
        if (cmp !== 0) {
          return cmp;
        }
        cmp = mappingA.originalColumn - mappingB.originalColumn;
        if (cmp !== 0) {
          return cmp;
        }
        return strcmp(mappingA.name, mappingB.name);
      }
      __name(compareByGeneratedPositionsDeflated, "compareByGeneratedPositionsDeflated");
      exports.compareByGeneratedPositionsDeflated = compareByGeneratedPositionsDeflated;
      function compareByGeneratedPositionsDeflatedNoLine(mappingA, mappingB, onlyCompareGenerated) {
        var cmp = mappingA.generatedColumn - mappingB.generatedColumn;
        if (cmp !== 0 || onlyCompareGenerated) {
          return cmp;
        }
        cmp = strcmp(mappingA.source, mappingB.source);
        if (cmp !== 0) {
          return cmp;
        }
        cmp = mappingA.originalLine - mappingB.originalLine;
        if (cmp !== 0) {
          return cmp;
        }
        cmp = mappingA.originalColumn - mappingB.originalColumn;
        if (cmp !== 0) {
          return cmp;
        }
        return strcmp(mappingA.name, mappingB.name);
      }
      __name(compareByGeneratedPositionsDeflatedNoLine, "compareByGeneratedPositionsDeflatedNoLine");
      exports.compareByGeneratedPositionsDeflatedNoLine = compareByGeneratedPositionsDeflatedNoLine;
      function strcmp(aStr1, aStr2) {
        if (aStr1 === aStr2) {
          return 0;
        }
        if (aStr1 === null) {
          return 1;
        }
        if (aStr2 === null) {
          return -1;
        }
        if (aStr1 > aStr2) {
          return 1;
        }
        return -1;
      }
      __name(strcmp, "strcmp");
      function compareByGeneratedPositionsInflated(mappingA, mappingB) {
        var cmp = mappingA.generatedLine - mappingB.generatedLine;
        if (cmp !== 0) {
          return cmp;
        }
        cmp = mappingA.generatedColumn - mappingB.generatedColumn;
        if (cmp !== 0) {
          return cmp;
        }
        cmp = strcmp(mappingA.source, mappingB.source);
        if (cmp !== 0) {
          return cmp;
        }
        cmp = mappingA.originalLine - mappingB.originalLine;
        if (cmp !== 0) {
          return cmp;
        }
        cmp = mappingA.originalColumn - mappingB.originalColumn;
        if (cmp !== 0) {
          return cmp;
        }
        return strcmp(mappingA.name, mappingB.name);
      }
      __name(compareByGeneratedPositionsInflated, "compareByGeneratedPositionsInflated");
      exports.compareByGeneratedPositionsInflated = compareByGeneratedPositionsInflated;
      function parseSourceMapInput(str) {
        return JSON.parse(str.replace(/^\)]}'[^\n]*\n/, ""));
      }
      __name(parseSourceMapInput, "parseSourceMapInput");
      exports.parseSourceMapInput = parseSourceMapInput;
      function computeSourceURL(sourceRoot, sourceURL, sourceMapURL) {
        sourceURL = sourceURL || "";
        if (sourceRoot) {
          if (sourceRoot[sourceRoot.length - 1] !== "/" && sourceURL[0] !== "/") {
            sourceRoot += "/";
          }
          sourceURL = sourceRoot + sourceURL;
        }
        if (sourceMapURL) {
          var parsed = urlParse(sourceMapURL);
          if (!parsed) {
            throw new Error("sourceMapURL could not be parsed");
          }
          if (parsed.path) {
            var index = parsed.path.lastIndexOf("/");
            if (index >= 0) {
              parsed.path = parsed.path.substring(0, index + 1);
            }
          }
          sourceURL = join(urlGenerate(parsed), sourceURL);
        }
        return normalize(sourceURL);
      }
      __name(computeSourceURL, "computeSourceURL");
      exports.computeSourceURL = computeSourceURL;
    }
  });

  // node_modules/.pnpm/source-map-js@1.2.1/node_modules/source-map-js/lib/array-set.js
  var require_array_set = __commonJS({
    "node_modules/.pnpm/source-map-js@1.2.1/node_modules/source-map-js/lib/array-set.js"(exports) {
      var util = require_util();
      var has = Object.prototype.hasOwnProperty;
      var hasNativeMap = typeof Map !== "undefined";
      function ArraySet() {
        this._array = [];
        this._set = hasNativeMap ? /* @__PURE__ */ new Map() : /* @__PURE__ */ Object.create(null);
      }
      __name(ArraySet, "ArraySet");
      ArraySet.fromArray = /* @__PURE__ */ __name(function ArraySet_fromArray(aArray, aAllowDuplicates) {
        var set = new ArraySet();
        for (var i = 0, len = aArray.length; i < len; i++) {
          set.add(aArray[i], aAllowDuplicates);
        }
        return set;
      }, "ArraySet_fromArray");
      ArraySet.prototype.size = /* @__PURE__ */ __name(function ArraySet_size() {
        return hasNativeMap ? this._set.size : Object.getOwnPropertyNames(this._set).length;
      }, "ArraySet_size");
      ArraySet.prototype.add = /* @__PURE__ */ __name(function ArraySet_add(aStr, aAllowDuplicates) {
        var sStr = hasNativeMap ? aStr : util.toSetString(aStr);
        var isDuplicate = hasNativeMap ? this.has(aStr) : has.call(this._set, sStr);
        var idx = this._array.length;
        if (!isDuplicate || aAllowDuplicates) {
          this._array.push(aStr);
        }
        if (!isDuplicate) {
          if (hasNativeMap) {
            this._set.set(aStr, idx);
          } else {
            this._set[sStr] = idx;
          }
        }
      }, "ArraySet_add");
      ArraySet.prototype.has = /* @__PURE__ */ __name(function ArraySet_has(aStr) {
        if (hasNativeMap) {
          return this._set.has(aStr);
        } else {
          var sStr = util.toSetString(aStr);
          return has.call(this._set, sStr);
        }
      }, "ArraySet_has");
      ArraySet.prototype.indexOf = /* @__PURE__ */ __name(function ArraySet_indexOf(aStr) {
        if (hasNativeMap) {
          var idx = this._set.get(aStr);
          if (idx >= 0) {
            return idx;
          }
        } else {
          var sStr = util.toSetString(aStr);
          if (has.call(this._set, sStr)) {
            return this._set[sStr];
          }
        }
        throw new Error('"' + aStr + '" is not in the set.');
      }, "ArraySet_indexOf");
      ArraySet.prototype.at = /* @__PURE__ */ __name(function ArraySet_at(aIdx) {
        if (aIdx >= 0 && aIdx < this._array.length) {
          return this._array[aIdx];
        }
        throw new Error("No element indexed by " + aIdx);
      }, "ArraySet_at");
      ArraySet.prototype.toArray = /* @__PURE__ */ __name(function ArraySet_toArray() {
        return this._array.slice();
      }, "ArraySet_toArray");
      exports.ArraySet = ArraySet;
    }
  });

  // node_modules/.pnpm/source-map-js@1.2.1/node_modules/source-map-js/lib/mapping-list.js
  var require_mapping_list = __commonJS({
    "node_modules/.pnpm/source-map-js@1.2.1/node_modules/source-map-js/lib/mapping-list.js"(exports) {
      var util = require_util();
      function generatedPositionAfter(mappingA, mappingB) {
        var lineA = mappingA.generatedLine;
        var lineB = mappingB.generatedLine;
        var columnA = mappingA.generatedColumn;
        var columnB = mappingB.generatedColumn;
        return lineB > lineA || lineB == lineA && columnB >= columnA || util.compareByGeneratedPositionsInflated(mappingA, mappingB) <= 0;
      }
      __name(generatedPositionAfter, "generatedPositionAfter");
      function MappingList() {
        this._array = [];
        this._sorted = true;
        this._last = { generatedLine: -1, generatedColumn: 0 };
      }
      __name(MappingList, "MappingList");
      MappingList.prototype.unsortedForEach = /* @__PURE__ */ __name(function MappingList_forEach(aCallback, aThisArg) {
        this._array.forEach(aCallback, aThisArg);
      }, "MappingList_forEach");
      MappingList.prototype.add = /* @__PURE__ */ __name(function MappingList_add(aMapping) {
        if (generatedPositionAfter(this._last, aMapping)) {
          this._last = aMapping;
          this._array.push(aMapping);
        } else {
          this._sorted = false;
          this._array.push(aMapping);
        }
      }, "MappingList_add");
      MappingList.prototype.toArray = /* @__PURE__ */ __name(function MappingList_toArray() {
        if (!this._sorted) {
          this._array.sort(util.compareByGeneratedPositionsInflated);
          this._sorted = true;
        }
        return this._array;
      }, "MappingList_toArray");
      exports.MappingList = MappingList;
    }
  });

  // node_modules/.pnpm/source-map-js@1.2.1/node_modules/source-map-js/lib/source-map-generator.js
  var require_source_map_generator = __commonJS({
    "node_modules/.pnpm/source-map-js@1.2.1/node_modules/source-map-js/lib/source-map-generator.js"(exports) {
      var base64VLQ = require_base64_vlq();
      var util = require_util();
      var ArraySet = require_array_set().ArraySet;
      var MappingList = require_mapping_list().MappingList;
      function SourceMapGenerator2(aArgs) {
        if (!aArgs) {
          aArgs = {};
        }
        this._file = util.getArg(aArgs, "file", null);
        this._sourceRoot = util.getArg(aArgs, "sourceRoot", null);
        this._skipValidation = util.getArg(aArgs, "skipValidation", false);
        this._ignoreInvalidMapping = util.getArg(aArgs, "ignoreInvalidMapping", false);
        this._sources = new ArraySet();
        this._names = new ArraySet();
        this._mappings = new MappingList();
        this._sourcesContents = null;
      }
      __name(SourceMapGenerator2, "SourceMapGenerator");
      SourceMapGenerator2.prototype._version = 3;
      SourceMapGenerator2.fromSourceMap = /* @__PURE__ */ __name(function SourceMapGenerator_fromSourceMap(aSourceMapConsumer, generatorOps) {
        var sourceRoot = aSourceMapConsumer.sourceRoot;
        var generator = new SourceMapGenerator2(Object.assign(generatorOps || {}, {
          file: aSourceMapConsumer.file,
          sourceRoot
        }));
        aSourceMapConsumer.eachMapping(function(mapping) {
          var newMapping = {
            generated: {
              line: mapping.generatedLine,
              column: mapping.generatedColumn
            }
          };
          if (mapping.source != null) {
            newMapping.source = mapping.source;
            if (sourceRoot != null) {
              newMapping.source = util.relative(sourceRoot, newMapping.source);
            }
            newMapping.original = {
              line: mapping.originalLine,
              column: mapping.originalColumn
            };
            if (mapping.name != null) {
              newMapping.name = mapping.name;
            }
          }
          generator.addMapping(newMapping);
        });
        aSourceMapConsumer.sources.forEach(function(sourceFile) {
          var sourceRelative = sourceFile;
          if (sourceRoot !== null) {
            sourceRelative = util.relative(sourceRoot, sourceFile);
          }
          if (!generator._sources.has(sourceRelative)) {
            generator._sources.add(sourceRelative);
          }
          var content = aSourceMapConsumer.sourceContentFor(sourceFile);
          if (content != null) {
            generator.setSourceContent(sourceFile, content);
          }
        });
        return generator;
      }, "SourceMapGenerator_fromSourceMap");
      SourceMapGenerator2.prototype.addMapping = /* @__PURE__ */ __name(function SourceMapGenerator_addMapping(aArgs) {
        var generated = util.getArg(aArgs, "generated");
        var original = util.getArg(aArgs, "original", null);
        var source = util.getArg(aArgs, "source", null);
        var name50 = util.getArg(aArgs, "name", null);
        if (!this._skipValidation) {
          if (this._validateMapping(generated, original, source, name50) === false) {
            return;
          }
        }
        if (source != null) {
          source = String(source);
          if (!this._sources.has(source)) {
            this._sources.add(source);
          }
        }
        if (name50 != null) {
          name50 = String(name50);
          if (!this._names.has(name50)) {
            this._names.add(name50);
          }
        }
        this._mappings.add({
          generatedLine: generated.line,
          generatedColumn: generated.column,
          originalLine: original != null && original.line,
          originalColumn: original != null && original.column,
          source,
          name: name50
        });
      }, "SourceMapGenerator_addMapping");
      SourceMapGenerator2.prototype.setSourceContent = /* @__PURE__ */ __name(function SourceMapGenerator_setSourceContent(aSourceFile, aSourceContent) {
        var source = aSourceFile;
        if (this._sourceRoot != null) {
          source = util.relative(this._sourceRoot, source);
        }
        if (aSourceContent != null) {
          if (!this._sourcesContents) {
            this._sourcesContents = /* @__PURE__ */ Object.create(null);
          }
          this._sourcesContents[util.toSetString(source)] = aSourceContent;
        } else if (this._sourcesContents) {
          delete this._sourcesContents[util.toSetString(source)];
          if (Object.keys(this._sourcesContents).length === 0) {
            this._sourcesContents = null;
          }
        }
      }, "SourceMapGenerator_setSourceContent");
      SourceMapGenerator2.prototype.applySourceMap = /* @__PURE__ */ __name(function SourceMapGenerator_applySourceMap(aSourceMapConsumer, aSourceFile, aSourceMapPath) {
        var sourceFile = aSourceFile;
        if (aSourceFile == null) {
          if (aSourceMapConsumer.file == null) {
            throw new Error(
              `SourceMapGenerator.prototype.applySourceMap requires either an explicit source file, or the source map's "file" property. Both were omitted.`
            );
          }
          sourceFile = aSourceMapConsumer.file;
        }
        var sourceRoot = this._sourceRoot;
        if (sourceRoot != null) {
          sourceFile = util.relative(sourceRoot, sourceFile);
        }
        var newSources = new ArraySet();
        var newNames = new ArraySet();
        this._mappings.unsortedForEach(function(mapping) {
          if (mapping.source === sourceFile && mapping.originalLine != null) {
            var original = aSourceMapConsumer.originalPositionFor({
              line: mapping.originalLine,
              column: mapping.originalColumn
            });
            if (original.source != null) {
              mapping.source = original.source;
              if (aSourceMapPath != null) {
                mapping.source = util.join(aSourceMapPath, mapping.source);
              }
              if (sourceRoot != null) {
                mapping.source = util.relative(sourceRoot, mapping.source);
              }
              mapping.originalLine = original.line;
              mapping.originalColumn = original.column;
              if (original.name != null) {
                mapping.name = original.name;
              }
            }
          }
          var source = mapping.source;
          if (source != null && !newSources.has(source)) {
            newSources.add(source);
          }
          var name50 = mapping.name;
          if (name50 != null && !newNames.has(name50)) {
            newNames.add(name50);
          }
        }, this);
        this._sources = newSources;
        this._names = newNames;
        aSourceMapConsumer.sources.forEach(function(sourceFile2) {
          var content = aSourceMapConsumer.sourceContentFor(sourceFile2);
          if (content != null) {
            if (aSourceMapPath != null) {
              sourceFile2 = util.join(aSourceMapPath, sourceFile2);
            }
            if (sourceRoot != null) {
              sourceFile2 = util.relative(sourceRoot, sourceFile2);
            }
            this.setSourceContent(sourceFile2, content);
          }
        }, this);
      }, "SourceMapGenerator_applySourceMap");
      SourceMapGenerator2.prototype._validateMapping = /* @__PURE__ */ __name(function SourceMapGenerator_validateMapping(aGenerated, aOriginal, aSource, aName) {
        if (aOriginal && typeof aOriginal.line !== "number" && typeof aOriginal.column !== "number") {
          var message = "original.line and original.column are not numbers -- you probably meant to omit the original mapping entirely and only map the generated position. If so, pass null for the original mapping instead of an object with empty or null values.";
          if (this._ignoreInvalidMapping) {
            if (typeof console !== "undefined" && console.warn) {
              console.warn(message);
            }
            return false;
          } else {
            throw new Error(message);
          }
        }
        if (aGenerated && "line" in aGenerated && "column" in aGenerated && aGenerated.line > 0 && aGenerated.column >= 0 && !aOriginal && !aSource && !aName) {
          return;
        } else if (aGenerated && "line" in aGenerated && "column" in aGenerated && aOriginal && "line" in aOriginal && "column" in aOriginal && aGenerated.line > 0 && aGenerated.column >= 0 && aOriginal.line > 0 && aOriginal.column >= 0 && aSource) {
          return;
        } else {
          var message = "Invalid mapping: " + JSON.stringify({
            generated: aGenerated,
            source: aSource,
            original: aOriginal,
            name: aName
          });
          if (this._ignoreInvalidMapping) {
            if (typeof console !== "undefined" && console.warn) {
              console.warn(message);
            }
            return false;
          } else {
            throw new Error(message);
          }
        }
      }, "SourceMapGenerator_validateMapping");
      SourceMapGenerator2.prototype._serializeMappings = /* @__PURE__ */ __name(function SourceMapGenerator_serializeMappings() {
        var previousGeneratedColumn = 0;
        var previousGeneratedLine = 1;
        var previousOriginalColumn = 0;
        var previousOriginalLine = 0;
        var previousName = 0;
        var previousSource = 0;
        var result = "";
        var next;
        var mapping;
        var nameIdx;
        var sourceIdx;
        var mappings = this._mappings.toArray();
        for (var i = 0, len = mappings.length; i < len; i++) {
          mapping = mappings[i];
          next = "";
          if (mapping.generatedLine !== previousGeneratedLine) {
            previousGeneratedColumn = 0;
            while (mapping.generatedLine !== previousGeneratedLine) {
              next += ";";
              previousGeneratedLine++;
            }
          } else {
            if (i > 0) {
              if (!util.compareByGeneratedPositionsInflated(mapping, mappings[i - 1])) {
                continue;
              }
              next += ",";
            }
          }
          next += base64VLQ.encode(mapping.generatedColumn - previousGeneratedColumn);
          previousGeneratedColumn = mapping.generatedColumn;
          if (mapping.source != null) {
            sourceIdx = this._sources.indexOf(mapping.source);
            next += base64VLQ.encode(sourceIdx - previousSource);
            previousSource = sourceIdx;
            next += base64VLQ.encode(mapping.originalLine - 1 - previousOriginalLine);
            previousOriginalLine = mapping.originalLine - 1;
            next += base64VLQ.encode(mapping.originalColumn - previousOriginalColumn);
            previousOriginalColumn = mapping.originalColumn;
            if (mapping.name != null) {
              nameIdx = this._names.indexOf(mapping.name);
              next += base64VLQ.encode(nameIdx - previousName);
              previousName = nameIdx;
            }
          }
          result += next;
        }
        return result;
      }, "SourceMapGenerator_serializeMappings");
      SourceMapGenerator2.prototype._generateSourcesContent = /* @__PURE__ */ __name(function SourceMapGenerator_generateSourcesContent(aSources, aSourceRoot) {
        return aSources.map(function(source) {
          if (!this._sourcesContents) {
            return null;
          }
          if (aSourceRoot != null) {
            source = util.relative(aSourceRoot, source);
          }
          var key = util.toSetString(source);
          return Object.prototype.hasOwnProperty.call(this._sourcesContents, key) ? this._sourcesContents[key] : null;
        }, this);
      }, "SourceMapGenerator_generateSourcesContent");
      SourceMapGenerator2.prototype.toJSON = /* @__PURE__ */ __name(function SourceMapGenerator_toJSON() {
        var map = {
          version: this._version,
          sources: this._sources.toArray(),
          names: this._names.toArray(),
          mappings: this._serializeMappings()
        };
        if (this._file != null) {
          map.file = this._file;
        }
        if (this._sourceRoot != null) {
          map.sourceRoot = this._sourceRoot;
        }
        if (this._sourcesContents) {
          map.sourcesContent = this._generateSourcesContent(map.sources, map.sourceRoot);
        }
        return map;
      }, "SourceMapGenerator_toJSON");
      SourceMapGenerator2.prototype.toString = /* @__PURE__ */ __name(function SourceMapGenerator_toString() {
        return JSON.stringify(this.toJSON());
      }, "SourceMapGenerator_toString");
      exports.SourceMapGenerator = SourceMapGenerator2;
    }
  });

  // vendor/src/vendor.entry.js
  var vendor_entry_exports = {};
  __export(vendor_entry_exports, {
    cssSelect: () => dist_exports5,
    cssTree: () => cssTree,
    cssWhat: () => dist_exports,
    xpathway: () => src_exports
  });

  // node_modules/.pnpm/css-select@7.0.0_patch_hash=93e85b409ab078491850a9f5ef5fd93f5c1c877b1bbac136ab3690b4d6ddf579/node_modules/css-select/dist/index.js
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

  // node_modules/.pnpm/css-what@8.0.0_patch_hash=8e7bc46fd2eb27541e917f8cb2ab9b1ba118ba0839519506e188c6d544662c4d/node_modules/css-what/dist/index.js
  var dist_exports = {};
  __export(dist_exports, {
    AttributeAction: () => AttributeAction,
    IgnoreCaseMode: () => IgnoreCaseMode,
    SelectorType: () => SelectorType,
    isTraversal: () => isTraversal,
    parse: () => parse,
    stringify: () => stringify
  });

  // node_modules/.pnpm/css-what@8.0.0_patch_hash=8e7bc46fd2eb27541e917f8cb2ab9b1ba118ba0839519506e188c6d544662c4d/node_modules/css-what/dist/types.js
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

  // node_modules/.pnpm/css-what@8.0.0_patch_hash=8e7bc46fd2eb27541e917f8cb2ab9b1ba118ba0839519506e188c6d544662c4d/node_modules/css-what/dist/parse.js
  var reName = /^[^#\\]?(?:\\(?:[\da-f]{1,6}(?:\r\n|\s)?|.|$)|[\w\u00B0-\uFFFF-])+/i;
  var reEscape = /\\([\da-f]{1,6}(?:\r\n|\s)?|(\s)|.|$)/gi;
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
  function isTraversal(selector2) {
    switch (selector2.type) {
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
    if (escaped === "") return "\uFFFD";
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
  function parse(selector2) {
    const subselects2 = [];
    const endIndex = parseSelector(subselects2, `${selector2}`, 0);
    if (endIndex < selector2.length) {
      throw new Error(`Unmatched selector: ${selector2.slice(endIndex)}`);
    }
    return subselects2;
  }
  __name(parse, "parse");
  function parseSelector(subselects2, selector2, selectorIndex) {
    let tokens = [];
    function getName2(offset) {
      const match = selector2.slice(selectorIndex + offset).match(reName);
      if (!match) {
        throw new Error(`Expected name, found ${selector2.slice(selectorIndex)}`);
      }
      const [name50] = match;
      selectorIndex += offset + name50.length;
      return unescapeCSS(name50);
    }
    __name(getName2, "getName");
    function stripWhitespace(offset) {
      selectorIndex += offset;
      while (selectorIndex < selector2.length && isWhitespace(selector2.charCodeAt(selectorIndex))) {
        selectorIndex++;
      }
    }
    __name(stripWhitespace, "stripWhitespace");
    function readValueWithParenthesis() {
      selectorIndex += 1;
      const start = selectorIndex;
      for (let counter = 1; selectorIndex < selector2.length; selectorIndex++) {
        switch (selector2.charCodeAt(selectorIndex)) {
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
              return unescapeCSS(selector2.slice(start, selectorIndex++));
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
    function addSpecialAttribute(name50, action) {
      tokens.push({
        type: SelectorType.Attribute,
        name: name50,
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
    if (selector2.length === selectorIndex) {
      return selectorIndex;
    }
    loop: while (selectorIndex < selector2.length) {
      const firstChar = selector2.charCodeAt(selectorIndex);
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
          let name50;
          let namespace = null;
          if (selector2.charCodeAt(selectorIndex) === CharCode.Pipe) {
            name50 = getName2(1);
          } else if (selector2.startsWith("*|", selectorIndex)) {
            namespace = "*";
            name50 = getName2(2);
          } else {
            name50 = getName2(0);
            if (selector2.charCodeAt(selectorIndex) === CharCode.Pipe && selector2.charCodeAt(selectorIndex + 1) !== CharCode.Equal) {
              namespace = name50;
              name50 = getName2(1);
            }
          }
          stripWhitespace(0);
          let action = AttributeAction.Exists;
          const possibleAction = actionTypes.get(selector2.charCodeAt(selectorIndex));
          if (possibleAction) {
            action = possibleAction;
            if (selector2.charCodeAt(selectorIndex + 1) !== CharCode.Equal) {
              throw new Error("Expected `=`");
            }
            stripWhitespace(2);
          } else if (selector2.charCodeAt(selectorIndex) === CharCode.Equal) {
            action = AttributeAction.Equals;
            stripWhitespace(1);
          }
          let value = "";
          let ignoreCase = null;
          if (action !== "exists") {
            if (isQuote(selector2.charCodeAt(selectorIndex))) {
              const quote = selector2.charCodeAt(selectorIndex);
              selectorIndex += 1;
              const sectionStart = selectorIndex;
              while (selectorIndex < selector2.length && selector2.charCodeAt(selectorIndex) !== quote) {
                selectorIndex += // Skip next character if it is escaped
                selector2.charCodeAt(selectorIndex) === CharCode.BackSlash ? 2 : 1;
              }
              value = unescapeCSS(selector2.slice(sectionStart, selectorIndex));
              if (selectorIndex < selector2.length) {
                selectorIndex += 1;
              }
            } else {
              const valueStart = selectorIndex;
              while (selectorIndex < selector2.length && !isWhitespace(selector2.charCodeAt(selectorIndex)) && selector2.charCodeAt(selectorIndex) !== CharCode.RightSquareBracket) {
                selectorIndex += // Skip next character if it is escaped
                selector2.charCodeAt(selectorIndex) === CharCode.BackSlash ? 2 : 1;
              }
              value = unescapeCSS(selector2.slice(valueStart, selectorIndex));
            }
            stripWhitespace(0);
            switch (selector2.charCodeAt(selectorIndex) | 32) {
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
          if (selectorIndex < selector2.length) {
            if (selector2.charCodeAt(selectorIndex) !== CharCode.RightSquareBracket) {
              throw new Error("Attribute selector didn't terminate");
            }
            selectorIndex += 1;
          }
          const attributeSelector = {
            type: SelectorType.Attribute,
            name: name50,
            action,
            value,
            namespace,
            ignoreCase
          };
          tokens.push(attributeSelector);
          break;
        }
        case CharCode.Colon: {
          if (selector2.charCodeAt(selectorIndex + 1) === CharCode.Colon) {
            tokens.push({
              type: SelectorType.PseudoElement,
              name: getName2(2).toLowerCase(),
              data: selector2.charCodeAt(selectorIndex) === CharCode.LeftParenthesis ? readValueWithParenthesis() : null
            });
            break;
          }
          const name50 = getName2(1).toLowerCase();
          if (pseudosToPseudoElements.has(name50)) {
            tokens.push({
              type: SelectorType.PseudoElement,
              name: name50,
              data: null
            });
            break;
          }
          let data = null;
          if (selector2.charCodeAt(selectorIndex) === CharCode.LeftParenthesis) {
            if (unpackPseudos.has(name50)) {
              if (isQuote(selector2.charCodeAt(selectorIndex + 1))) {
                throw new Error(`Pseudo-selector ${name50} cannot be quoted`);
              }
              data = [];
              selectorIndex = parseSelector(data, selector2, selectorIndex + 1);
              if (selector2.charCodeAt(selectorIndex) !== CharCode.RightParenthesis) {
                throw new Error(`Missing closing parenthesis in :${name50} (${selector2})`);
              }
              selectorIndex += 1;
            } else {
              data = readValueWithParenthesis();
              if (stripQuotesFromPseudos.has(name50)) {
                const quot = data.charCodeAt(0);
                if (quot === data.charCodeAt(data.length - 1) && isQuote(quot)) {
                  data = data.slice(1, -1);
                }
              }
              data = unescapeCSS(data);
            }
          }
          tokens.push({ type: SelectorType.Pseudo, name: name50, data });
          break;
        }
        case CharCode.Comma: {
          finalizeSubselector();
          tokens = [];
          stripWhitespace(1);
          break;
        }
        default: {
          if (selector2.startsWith("/*", selectorIndex)) {
            const endIndex = selector2.indexOf("*/", selectorIndex + 2);
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
          let name50;
          if (firstChar === CharCode.Asterisk) {
            selectorIndex += 1;
            name50 = "*";
          } else if (firstChar === CharCode.Pipe) {
            name50 = "";
            if (selector2.charCodeAt(selectorIndex + 1) === CharCode.Pipe) {
              addTraversal(SelectorType.ColumnCombinator);
              stripWhitespace(2);
              break;
            }
          } else if (reName.test(selector2.slice(selectorIndex))) {
            name50 = getName2(0);
          } else {
            break loop;
          }
          if (selector2.charCodeAt(selectorIndex) === CharCode.Pipe && selector2.charCodeAt(selectorIndex + 1) !== CharCode.Pipe) {
            namespace = name50;
            if (selector2.charCodeAt(selectorIndex + 1) === CharCode.Asterisk) {
              name50 = "*";
              selectorIndex += 2;
            } else {
              name50 = getName2(1);
            }
          }
          tokens.push(name50 === "*" ? { type: SelectorType.Universal, namespace } : { type: SelectorType.Tag, name: name50, namespace });
        }
      }
    }
    finalizeSubselector();
    return selectorIndex;
  }
  __name(parseSelector, "parseSelector");

  // node_modules/.pnpm/css-what@8.0.0_patch_hash=8e7bc46fd2eb27541e917f8cb2ab9b1ba118ba0839519506e188c6d544662c4d/node_modules/css-what/dist/stringify.js
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
  function stringify(selector2) {
    return selector2.map((token) => token.map((token2, index, array) => stringifyToken(token2, index, array)).join("")).join(", ");
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
        const name50 = getNamespacedName(token);
        if (token.action === AttributeAction.Exists) {
          return `[${name50}]`;
        }
        return `[${name50}${getActionValue(token.action)}="${escapeName(token.value, charsToEscapeInAttributeValue)}"${token.ignoreCase === null ? "" : token.ignoreCase ? " i" : " s"}]`;
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
  function escapeName(name50, charsToEscape) {
    let lastIndex = 0;
    let escapedName = "";
    for (let index = 0; index < name50.length; index++) {
      if (charsToEscape.has(name50.charCodeAt(index))) {
        escapedName += `${name50.slice(lastIndex, index)}\\${name50.charAt(index)}`;
        lastIndex = index + 1;
      }
    }
    return escapedName.length > 0 ? escapedName + name50.slice(lastIndex) : name50;
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
    tag_name(name50) {
      if (typeof name50 === "function") {
        return (element) => isTag2(element) && name50(element.name);
      }
      if (name50 === "*") {
        return isTag2;
      }
      return (element) => isTag2(element) && element.name === name50;
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
  var elementNames = new Map("altGlyph altGlyphDef altGlyphItem animateColor animateMotion animateTransform clipPath feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence foreignObject glyphRef linearGradient radialGradient textPath".split(" ").map((name50) => [name50.toLowerCase(), name50]));
  var attributeNames = new Map("definitionURL attributeName attributeType baseFrequency baseProfile calcMode clipPathUnits diffuseConstant edgeMode filterUnits glyphRef gradientTransform gradientUnits kernelMatrix kernelUnitLength keyPoints keySplines keyTimes lengthAdjust limitingConeAngle markerHeight markerUnits markerWidth maskContentUnits maskUnits numOctaves pathLength patternContentUnits patternTransform patternUnits pointsAtX pointsAtY pointsAtZ preserveAlpha preserveAspectRatio primitiveUnits refX refY repeatCount repeatDur requiredExtensions requiredFeatures specularConstant specularExponent spreadMethod startOffset stdDeviation stitchTiles surfaceScale systemLanguage tableValues targetX targetY textLength viewBox viewTarget xChannelSelector yChannelSelector zoomAndPan".split(" ").map((name50) => [name50.toLowerCase(), name50]));

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
    const { name: name50, children } = element;
    const isVoid = !xmlMode && voidElements.has(name50);
    let tag = `<${name50}${formatAttributes(element.attribs, options, xmlMode)}`;
    if (children.length === 0 && (xmlMode ? options.selfClosingTags !== false : options.selfClosingTags && isVoid)) {
      tag += xmlMode ? "/>" : " />";
    } else {
      tag += ">";
      if (children.length > 0) {
        tag += renderChildren(children, options, xmlMode);
      }
      if (!isVoid) {
        tag += `</${name50}>`;
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
    const encode3 = (options.encodeEntities ?? options.decodeEntities) === false ? replaceQuotes : xmlMode || options.encodeEntities !== "utf8" ? encodeXML : escapeAttribute;
    const isForeign = xmlMode === "foreign";
    const showEmpty = !!(options.emptyAttrs ?? xmlMode);
    let result = "";
    for (const key in attributes) {
      if (!Object.hasOwn(attributes, key))
        continue;
      const value = attributes[key];
      const k = isForeign ? attributeNames.get(key) ?? key : key;
      result += !showEmpty && (value == null || value === "") ? ` ${k}` : ` ${k}="${encode3(value == null ? "" : String(value))}"`;
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
  function getAttributeValue(element, name50) {
    const { attribs } = element;
    return attribs?.[name50];
  }
  __name(getAttributeValue, "getAttributeValue");
  function hasAttrib(element, name50) {
    const { attribs } = element;
    return attribs != null && Object.hasOwn(attribs, name50) && attribs[name50] != null;
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

  // node_modules/.pnpm/css-select@7.0.0_patch_hash=93e85b409ab078491850a9f5ef5fd93f5c1c877b1bbac136ab3690b4d6ddf579/node_modules/css-select/dist/attributes.js
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
  function shouldIgnoreCase(selector2, options) {
    return typeof selector2.ignoreCase === "boolean" ? selector2.ignoreCase : selector2.ignoreCase === "quirks" ? !!options.quirksMode : !options.xmlMode && caseInsensitiveAttributes.has(selector2.name);
  }
  __name(shouldIgnoreCase, "shouldIgnoreCase");
  var attributeRules = {
    equals(next, data, options) {
      const { adapter } = options;
      const { name: name50 } = data;
      let { value } = data;
      if (shouldIgnoreCase(data, options)) {
        value = value.toLowerCase();
        return (element) => {
          const attribute = adapter.getAttributeValue(element, name50);
          return attribute != null && attribute.length === value.length && attribute.toLowerCase() === value && next(element);
        };
      }
      return (element) => adapter.getAttributeValue(element, name50) === value && next(element);
    },
    hyphen(next, data, options) {
      const { adapter } = options;
      const { name: name50 } = data;
      let { value } = data;
      const { length } = value;
      if (shouldIgnoreCase(data, options)) {
        value = value.toLowerCase();
        return /* @__PURE__ */ __name(function hyphenIC(element) {
          const attribute = adapter.getAttributeValue(element, name50);
          return attribute != null && (attribute.length === length || attribute.charAt(length) === "-") && attribute.substr(0, length).toLowerCase() === value && next(element);
        }, "hyphenIC");
      }
      return /* @__PURE__ */ __name(function hyphen(element) {
        const attribute = adapter.getAttributeValue(element, name50);
        return attribute != null && (attribute.length === length || attribute.charAt(length) === "-") && attribute.substr(0, length) === value && next(element);
      }, "hyphen");
    },
    element(next, data, options) {
      const { adapter } = options;
      const { name: name50, value } = data;
      if (value === "" || whitespaceRe.test(value)) {
        return falseFunc;
      }
      const regex = new RegExp(`(?:^|\\s)${escapeRegex(value)}(?:$|\\s)`, shouldIgnoreCase(data, options) ? "i" : "");
      return /* @__PURE__ */ __name(function element(node) {
        const attribute = adapter.getAttributeValue(node, name50);
        return attribute != null && attribute.length >= value.length && regex.test(attribute) && next(node);
      }, "element");
    },
    exists(next, { name: name50 }, { adapter }) {
      return (element) => adapter.hasAttrib(element, name50) && next(element);
    },
    start(next, data, options) {
      const { adapter } = options;
      const { name: name50 } = data;
      let { value } = data;
      const { length } = value;
      if (length === 0) {
        return falseFunc;
      }
      if (shouldIgnoreCase(data, options)) {
        value = value.toLowerCase();
        return (element) => {
          const attribute = adapter.getAttributeValue(element, name50);
          return attribute != null && attribute.length >= length && attribute.substr(0, length).toLowerCase() === value && next(element);
        };
      }
      return (element) => !!adapter.getAttributeValue(element, name50)?.startsWith(value) && next(element);
    },
    end(next, data, options) {
      const { adapter } = options;
      const { name: name50 } = data;
      let { value } = data;
      const length = -value.length;
      if (length === 0) {
        return falseFunc;
      }
      if (shouldIgnoreCase(data, options)) {
        value = value.toLowerCase();
        return (element) => adapter.getAttributeValue(element, name50)?.substr(length).toLowerCase() === value && next(element);
      }
      return (element) => !!adapter.getAttributeValue(element, name50)?.endsWith(value) && next(element);
    },
    any(next, data, options) {
      const { adapter } = options;
      const { name: name50, value } = data;
      if (value === "") {
        return falseFunc;
      }
      if (shouldIgnoreCase(data, options)) {
        const regex = new RegExp(escapeRegex(value), "i");
        return /* @__PURE__ */ __name(function anyIC(element) {
          const attribute = adapter.getAttributeValue(element, name50);
          return attribute != null && attribute.length >= value.length && regex.test(attribute) && next(element);
        }, "anyIC");
      }
      return (element) => !!adapter.getAttributeValue(element, name50)?.includes(value) && next(element);
    },
    not(next, data, options) {
      const { adapter } = options;
      const { name: name50 } = data;
      let { value } = data;
      if (value === "") {
        return (element) => !!adapter.getAttributeValue(element, name50) && next(element);
      }
      if (shouldIgnoreCase(data, options)) {
        value = value.toLowerCase();
        return (element) => {
          const attribute = adapter.getAttributeValue(element, name50);
          return (attribute == null || attribute.length !== value.length || attribute.toLowerCase() !== value) && next(element);
        };
      }
      return (element) => adapter.getAttributeValue(element, name50) !== value && next(element);
    }
  };

  // node_modules/.pnpm/css-select@7.0.0_patch_hash=93e85b409ab078491850a9f5ef5fd93f5c1c877b1bbac136ab3690b4d6ddf579/node_modules/css-select/dist/helpers/querying.js
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

  // node_modules/.pnpm/css-select@7.0.0_patch_hash=93e85b409ab078491850a9f5ef5fd93f5c1c877b1bbac136ab3690b4d6ddf579/node_modules/css-select/dist/pseudo-selectors/aliases.js
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

  // node_modules/.pnpm/css-select@7.0.0_patch_hash=93e85b409ab078491850a9f5ef5fd93f5c1c877b1bbac136ab3690b4d6ddf579/node_modules/css-select/dist/helpers/cache.js
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

  // node_modules/.pnpm/css-select@7.0.0_patch_hash=93e85b409ab078491850a9f5ef5fd93f5c1c877b1bbac136ab3690b4d6ddf579/node_modules/css-select/dist/helpers/options.js
  function copyOptions(options) {
    const { context: _, rootFunc: __, ...copied } = options;
    return copied;
  }
  __name(copyOptions, "copyOptions");

  // node_modules/.pnpm/css-select@7.0.0_patch_hash=93e85b409ab078491850a9f5ef5fd93f5c1c877b1bbac136ab3690b4d6ddf579/node_modules/css-select/dist/pseudo-selectors/filters.js
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
    return /* @__PURE__ */ __name(function nth2(next, rule, options, context, compileToken2) {
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
      return /* @__PURE__ */ __name(function nth3(element) {
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
    lang(next, code2, { adapter }) {
      const ranges = code2.split(",").map((r) => r.trim()).filter((r) => r.length > 0).map((r) => r.replace(/^['"]|['"]$/g, "").toLowerCase().split("-"));
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
  function dynamicStatePseudo(name50) {
    return /* @__PURE__ */ __name(function dynamicPseudo(next, _rule, { adapter }) {
      const filterFunction = adapter[name50];
      if (typeof filterFunction !== "function") {
        return falseFunc;
      }
      return /* @__PURE__ */ __name(function active(element) {
        return filterFunction(element) && next(element);
      }, "active");
    }, "dynamicPseudo");
  }
  __name(dynamicStatePseudo, "dynamicStatePseudo");

  // node_modules/.pnpm/css-select@7.0.0_patch_hash=93e85b409ab078491850a9f5ef5fd93f5c1c877b1bbac136ab3690b4d6ddf579/node_modules/css-select/dist/pseudo-selectors/pseudos.js
  var pseudos = {
    empty(element, { adapter }) {
      const children = adapter.getChildren(element);
      return children.every((child) => !adapter.isTag(child) && adapter.getText(child) === "");
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
  function verifyPseudoArguments(pseudoClassCondition, name50, subselect, argumentIndex) {
    if (subselect === null) {
      if (pseudoClassCondition.length > argumentIndex) {
        throw new Error(`Pseudo-class :${name50} requires an argument`);
      }
    } else if (pseudoClassCondition.length === argumentIndex) {
      throw new Error(`Pseudo-class :${name50} doesn't have any arguments`);
    }
  }
  __name(verifyPseudoArguments, "verifyPseudoArguments");

  // node_modules/.pnpm/css-select@7.0.0_patch_hash=93e85b409ab078491850a9f5ef5fd93f5c1c877b1bbac136ab3690b4d6ddf579/node_modules/css-select/dist/helpers/selectors.js
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

  // node_modules/.pnpm/css-select@7.0.0_patch_hash=93e85b409ab078491850a9f5ef5fd93f5c1c877b1bbac136ab3690b4d6ddf579/node_modules/css-select/dist/pseudo-selectors/subselects.js
  var PLACEHOLDER_ELEMENT = {};
  function hasDependsOnCurrentElement(selector2) {
    return selector2.some((sel) => sel.length > 0 && (isTraversal2(sel[0]) || sel.some(includesScopePseudo)));
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

  // node_modules/.pnpm/css-select@7.0.0_patch_hash=93e85b409ab078491850a9f5ef5fd93f5c1c877b1bbac136ab3690b4d6ddf579/node_modules/css-select/dist/pseudo-selectors/index.js
  function compilePseudoSelector(next, selector2, options, context, compileToken2) {
    const { name: name50, data } = selector2;
    if (Array.isArray(data)) {
      if (!(name50 in subselects)) {
        throw new Error(`Unknown pseudo-class :${name50}(${data})`);
      }
      return subselects[name50](next, data, options, context, compileToken2);
    }
    const userPseudo = options.pseudos?.[name50];
    const stringPseudo = typeof userPseudo === "string" ? userPseudo : aliases[name50];
    if (typeof stringPseudo === "string") {
      if (data != null) {
        throw new Error(`Pseudo ${name50} doesn't have any arguments`);
      }
      const alias = parse(stringPseudo);
      return subselects["is"](next, alias, options, context, compileToken2);
    }
    if (typeof userPseudo === "function") {
      verifyPseudoArguments(userPseudo, name50, data, 1);
      return (element) => userPseudo(element, data) && next(element);
    }
    if (name50 in filters) {
      return filters[name50](next, data, options, context, compileToken2);
    }
    if (name50 in pseudos) {
      const pseudo = pseudos[name50];
      verifyPseudoArguments(pseudo, name50, data, 2);
      return (element) => pseudo(element, options, data) && next(element);
    }
    throw new Error(`Unknown pseudo-class :${name50}`);
  }
  __name(compilePseudoSelector, "compilePseudoSelector");

  // node_modules/.pnpm/css-select@7.0.0_patch_hash=93e85b409ab078491850a9f5ef5fd93f5c1c877b1bbac136ab3690b4d6ddf579/node_modules/css-select/dist/general.js
  function compileGeneralSelector(next, selector2, options, context, compileToken2, hasExpensiveSubselector) {
    const { adapter, equals, cacheResults } = options;
    switch (selector2.type) {
      case SelectorType.PseudoElement: {
        throw new Error("Pseudo-elements are not supported by css-select");
      }
      case SelectorType.ColumnCombinator: {
        throw new Error("Column combinators are not yet supported by css-select");
      }
      case SelectorType.Attribute: {
        if (selector2.namespace != null) {
          throw new Error("Namespaced attributes are not yet supported by css-select");
        }
        if (!options.xmlMode || options.lowerCaseAttributeNames) {
          selector2.name = selector2.name.toLowerCase();
        }
        return attributeRules[selector2.action](next, selector2, options);
      }
      case SelectorType.Pseudo: {
        return compilePseudoSelector(next, selector2, options, context, compileToken2);
      }
      // Tags
      case SelectorType.Tag: {
        if (selector2.namespace != null) {
          throw new Error("Namespaced tag names are not yet supported by css-select");
        }
        let { name: name50 } = selector2;
        if (!options.xmlMode || options.lowerCaseTags) {
          name50 = name50.toLowerCase();
        }
        return /* @__PURE__ */ __name(function tag(element) {
          return adapter.getName(element) === name50 && next(element);
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
        if (selector2.namespace != null && selector2.namespace !== "*") {
          throw new Error("Namespaced universal selectors are not yet supported by css-select");
        }
        return next;
      }
    }
  }
  __name(compileGeneralSelector, "compileGeneralSelector");

  // node_modules/.pnpm/css-select@7.0.0_patch_hash=93e85b409ab078491850a9f5ef5fd93f5c1c877b1bbac136ab3690b4d6ddf579/node_modules/css-select/dist/compile.js
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

  // node_modules/.pnpm/css-select@7.0.0_patch_hash=93e85b409ab078491850a9f5ef5fd93f5c1c877b1bbac136ab3690b4d6ddf579/node_modules/css-select/dist/index.js
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
  function compile2(selector2, options, context) {
    const convertedOptions = convertOptionFormats(options);
    const next = _compileUnsafe(selector2, convertedOptions, context);
    return next === falseFunc ? falseFunc : (element) => convertedOptions.adapter.isTag(element) && next(element);
  }
  __name(compile2, "compile");
  function _compileUnsafe(selector2, options, context) {
    return compileToken(typeof selector2 === "string" ? parse(selector2) : selector2, convertOptionFormats(options), context);
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

  // node_modules/.pnpm/xpathway@1.0.3/node_modules/xpathway/src/index.js
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

  // node_modules/.pnpm/xpathway@1.0.3/node_modules/xpathway/src/errors.js
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

  // node_modules/.pnpm/xpathway@1.0.3/node_modules/xpathway/src/lexer.js
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
        const name50 = readQNameString(expr, i);
        if (name50 == null) {
          throw new XPathSyntaxError("expected name after '$'", start);
        }
        i = name50.end;
        push(T.VARREF, name50.value, start);
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

  // node_modules/.pnpm/xpathway@1.0.3/node_modules/xpathway/src/parser.js
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
  function nodeTypeStep(axis, name50) {
    return { type: "Step", axis, nodeTest: { kind: "type", name: name50, literal: null }, predicates: [] };
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
        const name50 = this.next().value;
        if (!AXES.has(name50)) {
          throw new XPathSyntaxError(`unknown axis '${name50}'`, this.tokens[this.pos - 1].pos);
        }
        this.expect(T.DOUBLECOLON);
        axis = name50;
      }
      const nodeTest = this.parseNodeTest();
      const predicates = this.parsePredicates();
      return { type: "Step", axis, nodeTest, predicates };
    }
    // NodeTest ::= NameTest | NodeType '(' ')' | 'processing-instruction' '(' Literal ')'
    parseNodeTest() {
      if (this.is(T.NODETYPE)) {
        const name50 = this.next().value;
        this.expect(T.LPAREN);
        let literal = null;
        if (name50 === "processing-instruction" && this.is(T.LITERAL)) {
          literal = this.next().value;
        }
        this.expect(T.RPAREN);
        return { kind: "type", name: name50, literal };
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

  // node_modules/.pnpm/xpathway@1.0.3/node_modules/xpathway/src/types.js
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

  // node_modules/.pnpm/xpathway@1.0.3/node_modules/xpathway/src/compare.js
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
  function compareValueLiteral(op, value, literal) {
    if (op === "=" || op === "!=") {
      const equal = typeof literal === "number" ? stringToNumber(value) === literal : value === literal;
      return op === "=" ? equal : !equal;
    }
    const a = stringToNumber(value);
    const b = typeof literal === "number" ? literal : stringToNumber(literal);
    return REL_TESTS[op](a, b);
  }
  __name(compareValueLiteral, "compareValueLiteral");

  // node_modules/.pnpm/xpathway@1.0.3/node_modules/xpathway/src/node-types.js
  var ELEMENT = 1;
  var ATTRIBUTE = 2;
  var TEXT = 3;
  var PROCESSING_INSTRUCTION = 7;
  var COMMENT = 8;
  var DOCUMENT = 9;
  var XML_NS = "http://www.w3.org/XML/1998/namespace";
  var XHTML_NS = "http://www.w3.org/1999/xhtml";

  // node_modules/.pnpm/xpathway@1.0.3/node_modules/xpathway/src/axes.js
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
  function descendantsMatching(node, adapter, match, includeSelf) {
    const out = [];
    if (includeSelf && match(node)) out.push(node);
    const stack = [];
    pushChildrenReversed(node, adapter, stack);
    while (stack.length) {
      const n = stack.pop();
      if (match(n)) out.push(n);
      pushChildrenReversed(n, adapter, stack);
    }
    return out;
  }
  __name(descendantsMatching, "descendantsMatching");
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
    child: /* @__PURE__ */ __name((node, adapter) => adapter.childNodes(node), "child"),
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
    attribute: /* @__PURE__ */ __name((node, adapter) => adapter.attributes(node), "attribute"),
    // Namespace nodes are not modeled by the target DOMs (§5/§12); the namespace
    // axis is always empty. The `namespace::` syntax still parses and evaluates.
    namespace: /* @__PURE__ */ __name(() => [], "namespace")
  };
  function resolveAxis(axis) {
    const fn = AXES2[axis];
    if (!fn) throw new Error(`unsupported axis: ${axis}`);
    return fn;
  }
  __name(resolveAxis, "resolveAxis");

  // node_modules/.pnpm/xpathway@1.0.3/node_modules/xpathway/src/nodetest.js
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
  function asciiLower(s) {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
    }
    return out;
  }
  __name(asciiLower, "asciiLower");
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
  function attributeValue(node, nameTest, adapter, resolver, html) {
    if (adapter.nodeType(node) !== ELEMENT) return void 0;
    let namespaceURI = null;
    if (nameTest.prefix != null) {
      namespaceURI = resolvePrefix(resolver, nameTest.prefix);
      if (namespaceURI == null) {
        throw new XPathTypeError(`unresolved namespace prefix '${nameTest.prefix}'`);
      }
    }
    const local = html && nameTest.prefix == null ? asciiLower(nameTest.local) : nameTest.local;
    const value = adapter.getAttribute(node, namespaceURI, local);
    return value == null ? void 0 : value;
  }
  __name(attributeValue, "attributeValue");
  function documentNodeOf(node, adapter) {
    return adapter.nodeType(node) === DOCUMENT ? node : adapter.ownerDocument(node);
  }
  __name(documentNodeOf, "documentNodeOf");
  function isHtmlDocument(node, adapter) {
    const doc = documentNodeOf(node, adapter);
    return doc ? !!adapter.isHtmlDocument(doc) : false;
  }
  __name(isHtmlDocument, "isHtmlDocument");

  // node_modules/.pnpm/xpathway@1.0.3/node_modules/xpathway/src/functions.js
  function arity(name50, args, min, max = min) {
    if (args.length < min || args.length > max) {
      const range = min === max ? `${min}` : `${min}-${max}`;
      throw new XPathTypeError(`${name50}() expects ${range} argument(s), got ${args.length}`);
    }
  }
  __name(arity, "arity");
  function requireNodeSet(name50, value) {
    if (!isNodeSet(value)) {
      throw new XPathTypeError(`${name50}() requires a node-set argument`);
    }
    return value;
  }
  __name(requireNodeSet, "requireNodeSet");
  function targetNode(name50, ctx, args) {
    arity(name50, args, 0, 1);
    if (args.length === 0) return ctx.node;
    return requireNodeSet(name50, args[0]).first(ctx.adapter);
  }
  __name(targetNode, "targetNode");
  function targetString(name50, ctx, args) {
    arity(name50, args, 0, 1);
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

  // node_modules/.pnpm/xpathway@1.0.3/node_modules/xpathway/src/context.js
  function makeRootContext(node, adapter, { resolver = null, functions = coreFunctions } = {}) {
    return {
      node,
      position: 1,
      size: 1,
      adapter,
      resolver,
      functions,
      cache: /* @__PURE__ */ new Map(),
      html: isHtmlDocument(node, adapter)
    };
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
      cache: ctx.cache,
      html: ctx.html
    };
  }
  __name(withNode, "withNode");

  // node_modules/.pnpm/xpathway@1.0.3/node_modules/xpathway/src/evaluate.js
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
      const left = evaluate(ast.left, ctx);
      const right = evaluate(ast.right, ctx);
      if (!isNodeSet(left) || !isNodeSet(right)) {
        throw new XPathTypeError("union operand is not a node-set");
      }
      return unionNodeSets(left, right);
    }
    if (op === "=" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=") {
      const fast = tryAttributeComparison(ast, ctx);
      if (fast !== null) return fast;
      const left = evaluate(ast.left, ctx);
      const right = evaluate(ast.right, ctx);
      return op === "=" || op === "!=" ? compareEquality(op, left, right, ctx.adapter) : compareRelational(op, left, right, ctx.adapter);
    }
    const arith = ARITHMETIC[op];
    return arith(toNumber(evaluate(ast.left, ctx), ctx.adapter), toNumber(evaluate(ast.right, ctx), ctx.adapter));
  }
  __name(evaluateBinary, "evaluateBinary");
  var FLIP_REL = {
    "<": ">",
    ">": "<",
    "<=": ">=",
    ">=": "<="
  };
  function isSelfNodeStep(step) {
    return step.axis === "self" && step.nodeTest.kind === "type" && step.nodeTest.name === "node" && step.predicates.length === 0;
  }
  __name(isSelfNodeStep, "isSelfNodeStep");
  function singleRelativeStep(ast) {
    if (ast.type !== "Path" || ast.root != null) return null;
    const { steps } = ast;
    if (steps.length === 1) return steps[0];
    if (steps.length === 2 && isSelfNodeStep(steps[0])) return steps[1];
    return null;
  }
  __name(singleRelativeStep, "singleRelativeStep");
  function simpleAttributeNameTest(ast) {
    const step = singleRelativeStep(ast);
    if (step === null || step.axis !== "attribute" || step.predicates.length !== 0) return null;
    const test = step.nodeTest;
    return test.kind === "name" && test.local !== "*" ? test : null;
  }
  __name(simpleAttributeNameTest, "simpleAttributeNameTest");
  function constantOperand(ast) {
    if (ast.type === "Literal") return ast.value;
    if (ast.type === "Number") return ast.value;
    return void 0;
  }
  __name(constantOperand, "constantOperand");
  function tryAttributeComparison(ast, ctx) {
    let nameTest = simpleAttributeNameTest(ast.left);
    let literal = nameTest === null ? void 0 : constantOperand(ast.right);
    let attributeOnLeft = true;
    if (nameTest === null || literal === void 0) {
      nameTest = simpleAttributeNameTest(ast.right);
      literal = nameTest === null ? void 0 : constantOperand(ast.left);
      attributeOnLeft = false;
    }
    if (nameTest === null || literal === void 0) return null;
    const value = attributeValue(ctx.node, nameTest, ctx.adapter, ctx.resolver, ctx.html);
    if (value === void 0) return false;
    const op = !attributeOnLeft && FLIP_REL[ast.op] ? FLIP_REL[ast.op] : ast.op;
    return compareValueLiteral(op, value, literal);
  }
  __name(tryAttributeComparison, "tryAttributeComparison");
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
    const { html } = ctx;
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
    const out = [];
    if (inputNodes.length === 0) return out;
    const { adapter } = ctx;
    const seen = inputNodes.length > 1 && !DISJOINT_AXES.has(step.axis) ? /* @__PURE__ */ new Set() : null;
    const test = step.nodeTest;
    const matchesAll = test.kind === "type" && test.name === "node";
    const fuseDescendant = !matchesAll && (step.axis === "descendant" || step.axis === "descendant-or-self");
    const includeSelf = step.axis === "descendant-or-self";
    const match = fuseDescendant ? (n) => matchesNodeTest(n, test, step.axis, adapter, ctx.resolver, html) : null;
    const axisFn = fuseDescendant ? null : resolveAxis(step.axis);
    const predicates = step.predicates;
    const purity = predicates.length ? predicates.map(isPureNodeSet) : null;
    for (const node of inputNodes) {
      let candidates;
      if (fuseDescendant) {
        candidates = descendantsMatching(node, adapter, match, includeSelf);
      } else {
        candidates = axisFn(node, adapter);
        if (!matchesAll) {
          candidates = candidates.filter((n) => matchesNodeTest(n, test, step.axis, adapter, ctx.resolver, html));
        }
      }
      if (purity) candidates = applyPredicates(candidates, predicates, purity, ctx, html);
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
  function isPureNodeSet(ast) {
    if (ast.type === "Path" || ast.type === "Filter") return true;
    if (ast.type === "Binary" && ast.op === "union") {
      return isPureNodeSet(ast.left) && isPureNodeSet(ast.right);
    }
    return false;
  }
  __name(isPureNodeSet, "isPureNodeSet");
  function applyPredicates(nodes, predicates, purity, ctx, html) {
    let current = nodes;
    for (let p = 0; p < predicates.length; p++) {
      const predicate = predicates[p];
      const existence = purity[p];
      const size = current.length;
      const kept = [];
      for (let i = 0; i < current.length; i++) {
        const position = i + 1;
        const predCtx = withNode(ctx, current[i], position, size);
        let keep;
        if (existence) {
          keep = existsBoolean(predicate, predCtx, html);
        } else {
          const value = evaluate(predicate, predCtx);
          keep = typeof value === "number" ? value === position : toBoolean(value);
        }
        if (keep) kept.push(current[i]);
      }
      current = kept;
    }
    return current;
  }
  __name(applyPredicates, "applyPredicates");
  function existsBoolean(ast, ctx, html) {
    if (ast.type === "Binary" && ast.op === "union") {
      return existsBoolean(ast.left, ctx, html) || existsBoolean(ast.right, ctx, html);
    }
    if (ast.type === "Path") {
      return pathExists(ast, ctx, html);
    }
    return toBoolean(evaluate(ast, ctx));
  }
  __name(existsBoolean, "existsBoolean");
  function pathExists(ast, ctx, html) {
    const step = singleRelativeStep(ast);
    if (step !== null && step.predicates.length === 0) {
      if (step.axis === "self") {
        return matchesNodeTest(ctx.node, step.nodeTest, "self", ctx.adapter, ctx.resolver, html);
      }
      if (step.axis === "attribute" && step.nodeTest.kind === "name" && step.nodeTest.local !== "*") {
        return attributeValue(ctx.node, step.nodeTest, ctx.adapter, ctx.resolver, html) !== void 0;
      }
    }
    return evaluatePath(ast, ctx).size > 0;
  }
  __name(pathExists, "pathExists");
  function evaluateFilter(ast, ctx) {
    const value = evaluate(ast.primary, ctx);
    if (!isNodeSet(value)) {
      throw new XPathTypeError("predicate applied to a non-node-set value");
    }
    const ordered = value.ordered(ctx.adapter).slice();
    const purity = ast.predicates.map(isPureNodeSet);
    return new NodeSet(applyPredicates(ordered, ast.predicates, purity, ctx, ctx.html), true);
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

  // node_modules/.pnpm/xpathway@1.0.3/node_modules/xpathway/src/api.js
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
  for (const [name50, val] of Object.entries(RESULT_CONSTANTS)) {
    XPathResult[name50] = val;
    XPathResult.prototype[name50] = val;
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

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/utils/List.js
  var releasedCursors = null;
  var List = class _List {
    static {
      __name(this, "List");
    }
    static createItem(data) {
      return {
        prev: null,
        next: null,
        data
      };
    }
    constructor() {
      this.head = null;
      this.tail = null;
      this.cursor = null;
    }
    createItem(data) {
      return _List.createItem(data);
    }
    // cursor helpers
    allocateCursor(prev, next) {
      let cursor;
      if (releasedCursors !== null) {
        cursor = releasedCursors;
        releasedCursors = releasedCursors.cursor;
        cursor.prev = prev;
        cursor.next = next;
        cursor.cursor = this.cursor;
      } else {
        cursor = {
          prev,
          next,
          cursor: this.cursor
        };
      }
      this.cursor = cursor;
      return cursor;
    }
    releaseCursor() {
      const { cursor } = this;
      this.cursor = cursor.cursor;
      cursor.prev = null;
      cursor.next = null;
      cursor.cursor = releasedCursors;
      releasedCursors = cursor;
    }
    updateCursors(prevOld, prevNew, nextOld, nextNew) {
      let { cursor } = this;
      while (cursor !== null) {
        if (cursor.prev === prevOld) {
          cursor.prev = prevNew;
        }
        if (cursor.next === nextOld) {
          cursor.next = nextNew;
        }
        cursor = cursor.cursor;
      }
    }
    *[Symbol.iterator]() {
      for (let cursor = this.head; cursor !== null; cursor = cursor.next) {
        yield cursor.data;
      }
    }
    // getters
    get size() {
      let size = 0;
      for (let cursor = this.head; cursor !== null; cursor = cursor.next) {
        size++;
      }
      return size;
    }
    get isEmpty() {
      return this.head === null;
    }
    get first() {
      return this.head && this.head.data;
    }
    get last() {
      return this.tail && this.tail.data;
    }
    // convertors
    fromArray(array) {
      let cursor = null;
      this.head = null;
      for (let data of array) {
        const item = _List.createItem(data);
        if (cursor !== null) {
          cursor.next = item;
        } else {
          this.head = item;
        }
        item.prev = cursor;
        cursor = item;
      }
      this.tail = cursor;
      return this;
    }
    toArray() {
      return [...this];
    }
    toJSON() {
      return [...this];
    }
    // array-like methods
    forEach(fn, thisArg = this) {
      const cursor = this.allocateCursor(null, this.head);
      while (cursor.next !== null) {
        const item = cursor.next;
        cursor.next = item.next;
        fn.call(thisArg, item.data, item, this);
      }
      this.releaseCursor();
    }
    forEachRight(fn, thisArg = this) {
      const cursor = this.allocateCursor(this.tail, null);
      while (cursor.prev !== null) {
        const item = cursor.prev;
        cursor.prev = item.prev;
        fn.call(thisArg, item.data, item, this);
      }
      this.releaseCursor();
    }
    reduce(fn, initialValue, thisArg = this) {
      let cursor = this.allocateCursor(null, this.head);
      let acc = initialValue;
      let item;
      while (cursor.next !== null) {
        item = cursor.next;
        cursor.next = item.next;
        acc = fn.call(thisArg, acc, item.data, item, this);
      }
      this.releaseCursor();
      return acc;
    }
    reduceRight(fn, initialValue, thisArg = this) {
      let cursor = this.allocateCursor(this.tail, null);
      let acc = initialValue;
      let item;
      while (cursor.prev !== null) {
        item = cursor.prev;
        cursor.prev = item.prev;
        acc = fn.call(thisArg, acc, item.data, item, this);
      }
      this.releaseCursor();
      return acc;
    }
    some(fn, thisArg = this) {
      for (let cursor = this.head; cursor !== null; cursor = cursor.next) {
        if (fn.call(thisArg, cursor.data, cursor, this)) {
          return true;
        }
      }
      return false;
    }
    map(fn, thisArg = this) {
      const result = new _List();
      for (let cursor = this.head; cursor !== null; cursor = cursor.next) {
        result.appendData(fn.call(thisArg, cursor.data, cursor, this));
      }
      return result;
    }
    filter(fn, thisArg = this) {
      const result = new _List();
      for (let cursor = this.head; cursor !== null; cursor = cursor.next) {
        if (fn.call(thisArg, cursor.data, cursor, this)) {
          result.appendData(cursor.data);
        }
      }
      return result;
    }
    nextUntil(start, fn, thisArg = this) {
      if (start === null) {
        return;
      }
      const cursor = this.allocateCursor(null, start);
      while (cursor.next !== null) {
        const item = cursor.next;
        cursor.next = item.next;
        if (fn.call(thisArg, item.data, item, this)) {
          break;
        }
      }
      this.releaseCursor();
    }
    prevUntil(start, fn, thisArg = this) {
      if (start === null) {
        return;
      }
      const cursor = this.allocateCursor(start, null);
      while (cursor.prev !== null) {
        const item = cursor.prev;
        cursor.prev = item.prev;
        if (fn.call(thisArg, item.data, item, this)) {
          break;
        }
      }
      this.releaseCursor();
    }
    // mutation
    clear() {
      this.head = null;
      this.tail = null;
    }
    copy() {
      const result = new _List();
      for (let data of this) {
        result.appendData(data);
      }
      return result;
    }
    prepend(item) {
      this.updateCursors(null, item, this.head, item);
      if (this.head !== null) {
        this.head.prev = item;
        item.next = this.head;
      } else {
        this.tail = item;
      }
      this.head = item;
      return this;
    }
    prependData(data) {
      return this.prepend(_List.createItem(data));
    }
    append(item) {
      return this.insert(item);
    }
    appendData(data) {
      return this.insert(_List.createItem(data));
    }
    insert(item, before = null) {
      if (before !== null) {
        this.updateCursors(before.prev, item, before, item);
        if (before.prev === null) {
          if (this.head !== before) {
            throw new Error("before doesn't belong to list");
          }
          this.head = item;
          before.prev = item;
          item.next = before;
          this.updateCursors(null, item);
        } else {
          before.prev.next = item;
          item.prev = before.prev;
          before.prev = item;
          item.next = before;
        }
      } else {
        this.updateCursors(this.tail, item, null, item);
        if (this.tail !== null) {
          this.tail.next = item;
          item.prev = this.tail;
        } else {
          this.head = item;
        }
        this.tail = item;
      }
      return this;
    }
    insertData(data, before) {
      return this.insert(_List.createItem(data), before);
    }
    remove(item) {
      this.updateCursors(item, item.prev, item, item.next);
      if (item.prev !== null) {
        item.prev.next = item.next;
      } else {
        if (this.head !== item) {
          throw new Error("item doesn't belong to list");
        }
        this.head = item.next;
      }
      if (item.next !== null) {
        item.next.prev = item.prev;
      } else {
        if (this.tail !== item) {
          throw new Error("item doesn't belong to list");
        }
        this.tail = item.prev;
      }
      item.prev = null;
      item.next = null;
      return item;
    }
    push(data) {
      this.insert(_List.createItem(data));
    }
    pop() {
      return this.tail !== null ? this.remove(this.tail) : null;
    }
    unshift(data) {
      this.prepend(_List.createItem(data));
    }
    shift() {
      return this.head !== null ? this.remove(this.head) : null;
    }
    prependList(list) {
      return this.insertList(list, this.head);
    }
    appendList(list) {
      return this.insertList(list);
    }
    insertList(list, before) {
      if (list.head === null) {
        return this;
      }
      if (before !== void 0 && before !== null) {
        this.updateCursors(before.prev, list.tail, before, list.head);
        if (before.prev !== null) {
          before.prev.next = list.head;
          list.head.prev = before.prev;
        } else {
          this.head = list.head;
        }
        before.prev = list.tail;
        list.tail.next = before;
      } else {
        this.updateCursors(this.tail, list.tail, null, list.head);
        if (this.tail !== null) {
          this.tail.next = list.head;
          list.head.prev = this.tail;
        } else {
          this.head = list.head;
        }
        this.tail = list.tail;
      }
      list.head = null;
      list.tail = null;
      return this;
    }
    replace(oldItem, newItemOrList) {
      if ("head" in newItemOrList) {
        this.insertList(newItemOrList, oldItem);
      } else {
        this.insert(newItemOrList, oldItem);
      }
      this.remove(oldItem);
    }
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/utils/create-custom-error.js
  function createCustomError(name50, message) {
    const error = Object.create(SyntaxError.prototype);
    const errorStack = new Error();
    return Object.assign(error, {
      name: name50,
      message,
      get stack() {
        return (errorStack.stack || "").replace(/^(.+\n){1,3}/, `${name50}: ${message}
`);
      }
    });
  }
  __name(createCustomError, "createCustomError");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/parser/SyntaxError.js
  var MAX_LINE_LENGTH = 100;
  var OFFSET_CORRECTION = 60;
  var TAB_REPLACEMENT = "    ";
  function sourceFragment({ source, line, column, baseLine, baseColumn }, extraLines) {
    function processLines(start, end) {
      return lines.slice(start, end).map(
        (line2, idx) => String(start + idx + 1).padStart(maxNumLength) + " |" + line2
      ).join("\n");
    }
    __name(processLines, "processLines");
    const prelines = "\n".repeat(Math.max(baseLine - 1, 0));
    const precolumns = " ".repeat(Math.max(baseColumn - 1, 0));
    const lines = (prelines + precolumns + source).split(/\r\n?|\n|\f/);
    const startLine = Math.max(1, line - extraLines) - 1;
    const endLine = Math.min(line + extraLines, lines.length + 1);
    const maxNumLength = Math.max(4, String(endLine).length) + 1;
    let cutLeft = 0;
    column += (TAB_REPLACEMENT.length - 1) * (lines[line - 1].substr(0, column - 1).match(/\t/g) || []).length;
    if (column > MAX_LINE_LENGTH) {
      cutLeft = column - OFFSET_CORRECTION + 3;
      column = OFFSET_CORRECTION - 2;
    }
    for (let i = startLine; i <= endLine; i++) {
      if (i >= 0 && i < lines.length) {
        lines[i] = lines[i].replace(/\t/g, TAB_REPLACEMENT);
        lines[i] = (cutLeft > 0 && lines[i].length > cutLeft ? "\u2026" : "") + lines[i].substr(cutLeft, MAX_LINE_LENGTH - 2) + (lines[i].length > cutLeft + MAX_LINE_LENGTH - 1 ? "\u2026" : "");
      }
    }
    return [
      processLines(startLine, line),
      new Array(column + maxNumLength + 2).join("-") + "^",
      processLines(line, endLine)
    ].filter(Boolean).join("\n").replace(/^(\s+\d+\s+\|\n)+/, "").replace(/\n(\s+\d+\s+\|)+$/, "");
  }
  __name(sourceFragment, "sourceFragment");
  function SyntaxError2(message, source, offset, line, column, baseLine = 1, baseColumn = 1) {
    const error = Object.assign(createCustomError("SyntaxError", message), {
      source,
      offset,
      line,
      column,
      sourceFragment(extraLines) {
        return sourceFragment({ source, line, column, baseLine, baseColumn }, isNaN(extraLines) ? 0 : extraLines);
      },
      get formattedMessage() {
        return `Parse error: ${message}
` + sourceFragment({ source, line, column, baseLine, baseColumn }, 2);
      }
    });
    return error;
  }
  __name(SyntaxError2, "SyntaxError");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/tokenizer/types.js
  var EOF = 0;
  var Ident = 1;
  var Function = 2;
  var AtKeyword = 3;
  var Hash = 4;
  var String2 = 5;
  var BadString = 6;
  var Url = 7;
  var BadUrl = 8;
  var Delim = 9;
  var Number2 = 10;
  var Percentage = 11;
  var Dimension = 12;
  var WhiteSpace = 13;
  var CDO = 14;
  var CDC = 15;
  var Colon = 16;
  var Semicolon = 17;
  var Comma = 18;
  var LeftSquareBracket = 19;
  var RightSquareBracket = 20;
  var LeftParenthesis = 21;
  var RightParenthesis = 22;
  var LeftCurlyBracket = 23;
  var RightCurlyBracket = 24;
  var Comment2 = 25;

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/tokenizer/char-code-definitions.js
  var EOF2 = 0;
  function isDigit2(code2) {
    return code2 >= 48 && code2 <= 57;
  }
  __name(isDigit2, "isDigit");
  function isHexDigit(code2) {
    return isDigit2(code2) || // 0 .. 9
    code2 >= 65 && code2 <= 70 || // A .. F
    code2 >= 97 && code2 <= 102;
  }
  __name(isHexDigit, "isHexDigit");
  function isUppercaseLetter(code2) {
    return code2 >= 65 && code2 <= 90;
  }
  __name(isUppercaseLetter, "isUppercaseLetter");
  function isLowercaseLetter(code2) {
    return code2 >= 97 && code2 <= 122;
  }
  __name(isLowercaseLetter, "isLowercaseLetter");
  function isLetter(code2) {
    return isUppercaseLetter(code2) || isLowercaseLetter(code2);
  }
  __name(isLetter, "isLetter");
  function isNonAscii(code2) {
    return code2 >= 128;
  }
  __name(isNonAscii, "isNonAscii");
  function isNameStart2(code2) {
    return isLetter(code2) || isNonAscii(code2) || code2 === 95;
  }
  __name(isNameStart2, "isNameStart");
  function isName(code2) {
    return isNameStart2(code2) || isDigit2(code2) || code2 === 45;
  }
  __name(isName, "isName");
  function isNonPrintable(code2) {
    return code2 >= 0 && code2 <= 8 || code2 === 11 || code2 >= 14 && code2 <= 31 || code2 === 127;
  }
  __name(isNonPrintable, "isNonPrintable");
  function isNewline(code2) {
    return code2 === 10 || code2 === 13 || code2 === 12;
  }
  __name(isNewline, "isNewline");
  function isWhiteSpace(code2) {
    return isNewline(code2) || code2 === 32 || code2 === 9;
  }
  __name(isWhiteSpace, "isWhiteSpace");
  function isValidEscape(first, second) {
    if (first !== 92) {
      return false;
    }
    if (isNewline(second) || second === EOF2) {
      return false;
    }
    return true;
  }
  __name(isValidEscape, "isValidEscape");
  function isIdentifierStart(first, second, third) {
    if (first === 45) {
      return isNameStart2(second) || second === 45 || isValidEscape(second, third);
    }
    if (isNameStart2(first)) {
      return true;
    }
    if (first === 92) {
      return isValidEscape(first, second);
    }
    return false;
  }
  __name(isIdentifierStart, "isIdentifierStart");
  function isNumberStart(first, second, third) {
    if (first === 43 || first === 45) {
      if (isDigit2(second)) {
        return 2;
      }
      return second === 46 && isDigit2(third) ? 3 : 0;
    }
    if (first === 46) {
      return isDigit2(second) ? 2 : 0;
    }
    if (isDigit2(first)) {
      return 1;
    }
    return 0;
  }
  __name(isNumberStart, "isNumberStart");
  function isBOM(code2) {
    if (code2 === 65279) {
      return 1;
    }
    if (code2 === 65534) {
      return 1;
    }
    return 0;
  }
  __name(isBOM, "isBOM");
  var CATEGORY = new Array(128);
  var EofCategory = 128;
  var WhiteSpaceCategory = 130;
  var DigitCategory = 131;
  var NameStartCategory = 132;
  var NonPrintableCategory = 133;
  for (let i = 0; i < CATEGORY.length; i++) {
    CATEGORY[i] = isWhiteSpace(i) && WhiteSpaceCategory || isDigit2(i) && DigitCategory || isNameStart2(i) && NameStartCategory || isNonPrintable(i) && NonPrintableCategory || i || EofCategory;
  }
  function charCodeCategory(code2) {
    return code2 < 128 ? CATEGORY[code2] : NameStartCategory;
  }
  __name(charCodeCategory, "charCodeCategory");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/tokenizer/utils.js
  function getCharCode(source, offset) {
    return offset < source.length ? source.charCodeAt(offset) : 0;
  }
  __name(getCharCode, "getCharCode");
  function getNewlineLength(source, offset, code2) {
    if (code2 === 13 && getCharCode(source, offset + 1) === 10) {
      return 2;
    }
    return 1;
  }
  __name(getNewlineLength, "getNewlineLength");
  function cmpChar(testStr, offset, referenceCode) {
    let code2 = testStr.charCodeAt(offset);
    if (isUppercaseLetter(code2)) {
      code2 = code2 | 32;
    }
    return code2 === referenceCode;
  }
  __name(cmpChar, "cmpChar");
  function cmpStr(testStr, start, end, referenceStr) {
    if (end - start !== referenceStr.length) {
      return false;
    }
    if (start < 0 || end > testStr.length) {
      return false;
    }
    for (let i = start; i < end; i++) {
      const referenceCode = referenceStr.charCodeAt(i - start);
      let testCode = testStr.charCodeAt(i);
      if (isUppercaseLetter(testCode)) {
        testCode = testCode | 32;
      }
      if (testCode !== referenceCode) {
        return false;
      }
    }
    return true;
  }
  __name(cmpStr, "cmpStr");
  function findWhiteSpaceStart(source, offset) {
    for (; offset >= 0; offset--) {
      if (!isWhiteSpace(source.charCodeAt(offset))) {
        break;
      }
    }
    return offset + 1;
  }
  __name(findWhiteSpaceStart, "findWhiteSpaceStart");
  function findWhiteSpaceEnd(source, offset) {
    for (; offset < source.length; offset++) {
      if (!isWhiteSpace(source.charCodeAt(offset))) {
        break;
      }
    }
    return offset;
  }
  __name(findWhiteSpaceEnd, "findWhiteSpaceEnd");
  function findDecimalNumberEnd(source, offset) {
    for (; offset < source.length; offset++) {
      if (!isDigit2(source.charCodeAt(offset))) {
        break;
      }
    }
    return offset;
  }
  __name(findDecimalNumberEnd, "findDecimalNumberEnd");
  function consumeEscaped(source, offset) {
    offset += 2;
    if (isHexDigit(getCharCode(source, offset - 1))) {
      for (const maxOffset = Math.min(source.length, offset + 5); offset < maxOffset; offset++) {
        if (!isHexDigit(getCharCode(source, offset))) {
          break;
        }
      }
      const code2 = getCharCode(source, offset);
      if (isWhiteSpace(code2)) {
        offset += getNewlineLength(source, offset, code2);
      }
    }
    return offset;
  }
  __name(consumeEscaped, "consumeEscaped");
  function consumeName(source, offset) {
    for (; offset < source.length; offset++) {
      const code2 = source.charCodeAt(offset);
      if (isName(code2)) {
        continue;
      }
      if (isValidEscape(code2, getCharCode(source, offset + 1))) {
        offset = consumeEscaped(source, offset) - 1;
        continue;
      }
      break;
    }
    return offset;
  }
  __name(consumeName, "consumeName");
  function consumeNumber(source, offset) {
    let code2 = source.charCodeAt(offset);
    if (code2 === 43 || code2 === 45) {
      code2 = source.charCodeAt(offset += 1);
    }
    if (isDigit2(code2)) {
      offset = findDecimalNumberEnd(source, offset + 1);
      code2 = source.charCodeAt(offset);
    }
    if (code2 === 46 && isDigit2(source.charCodeAt(offset + 1))) {
      offset += 2;
      offset = findDecimalNumberEnd(source, offset);
    }
    if (cmpChar(
      source,
      offset,
      101
      /* e */
    )) {
      let sign = 0;
      code2 = source.charCodeAt(offset + 1);
      if (code2 === 45 || code2 === 43) {
        sign = 1;
        code2 = source.charCodeAt(offset + 2);
      }
      if (isDigit2(code2)) {
        offset = findDecimalNumberEnd(source, offset + 1 + sign + 1);
      }
    }
    return offset;
  }
  __name(consumeNumber, "consumeNumber");
  function consumeBadUrlRemnants(source, offset) {
    for (; offset < source.length; offset++) {
      const code2 = source.charCodeAt(offset);
      if (code2 === 41) {
        offset++;
        break;
      }
      if (isValidEscape(code2, getCharCode(source, offset + 1))) {
        offset = consumeEscaped(source, offset);
      }
    }
    return offset;
  }
  __name(consumeBadUrlRemnants, "consumeBadUrlRemnants");
  function decodeEscaped(escaped) {
    if (escaped.length === 1 && !isHexDigit(escaped.charCodeAt(0))) {
      return escaped[0];
    }
    let code2 = parseInt(escaped, 16);
    if (code2 === 0 || // If this number is zero,
    code2 >= 55296 && code2 <= 57343 || // or is for a surrogate,
    code2 > 1114111) {
      code2 = 65533;
    }
    return String.fromCodePoint(code2);
  }
  __name(decodeEscaped, "decodeEscaped");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/tokenizer/names.js
  var names_default = [
    "EOF-token",
    "ident-token",
    "function-token",
    "at-keyword-token",
    "hash-token",
    "string-token",
    "bad-string-token",
    "url-token",
    "bad-url-token",
    "delim-token",
    "number-token",
    "percentage-token",
    "dimension-token",
    "whitespace-token",
    "CDO-token",
    "CDC-token",
    "colon-token",
    "semicolon-token",
    "comma-token",
    "[-token",
    "]-token",
    "(-token",
    ")-token",
    "{-token",
    "}-token",
    "comment-token"
  ];

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/tokenizer/adopt-buffer.js
  var MIN_SIZE = 16 * 1024;
  function adoptBuffer(buffer = null, size) {
    if (buffer === null || buffer.length < size) {
      return new Uint32Array(Math.max(size + 1024, MIN_SIZE));
    }
    return buffer;
  }
  __name(adoptBuffer, "adoptBuffer");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/tokenizer/OffsetToLocation.js
  var N = 10;
  var F = 12;
  var R = 13;
  function computeLinesAndColumns(host) {
    const source = host.source;
    const sourceLength = source.length;
    const startOffset = source.length > 0 ? isBOM(source.charCodeAt(0)) : 0;
    const lines = adoptBuffer(host.lines, sourceLength);
    const columns = adoptBuffer(host.columns, sourceLength);
    let line = host.startLine;
    let column = host.startColumn;
    for (let i = startOffset; i < sourceLength; i++) {
      const code2 = source.charCodeAt(i);
      lines[i] = line;
      columns[i] = column++;
      if (code2 === N || code2 === R || code2 === F) {
        if (code2 === R && i + 1 < sourceLength && source.charCodeAt(i + 1) === N) {
          i++;
          lines[i] = line;
          columns[i] = column;
        }
        line++;
        column = 1;
      }
    }
    lines[sourceLength] = line;
    columns[sourceLength] = column;
    host.lines = lines;
    host.columns = columns;
    host.computed = true;
  }
  __name(computeLinesAndColumns, "computeLinesAndColumns");
  var OffsetToLocation = class {
    static {
      __name(this, "OffsetToLocation");
    }
    constructor(source, startOffset, startLine, startColumn) {
      this.setSource(source, startOffset, startLine, startColumn);
      this.lines = null;
      this.columns = null;
    }
    setSource(source = "", startOffset = 0, startLine = 1, startColumn = 1) {
      this.source = source;
      this.startOffset = startOffset;
      this.startLine = startLine;
      this.startColumn = startColumn;
      this.computed = false;
    }
    getLocation(offset, filename) {
      if (!this.computed) {
        computeLinesAndColumns(this);
      }
      return {
        source: filename,
        offset: this.startOffset + offset,
        line: this.lines[offset],
        column: this.columns[offset]
      };
    }
    getLocationRange(start, end, filename) {
      if (!this.computed) {
        computeLinesAndColumns(this);
      }
      return {
        source: filename,
        start: {
          offset: this.startOffset + start,
          line: this.lines[start],
          column: this.columns[start]
        },
        end: {
          offset: this.startOffset + end,
          line: this.lines[end],
          column: this.columns[end]
        }
      };
    }
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/tokenizer/TokenStream.js
  var OFFSET_MASK = 16777215;
  var TYPE_SHIFT = 24;
  var BLOCK_OPEN_TOKEN = 1;
  var BLOCK_CLOSE_TOKEN = 2;
  var balancePair = new Uint8Array(32);
  balancePair[Function] = RightParenthesis;
  balancePair[LeftParenthesis] = RightParenthesis;
  balancePair[LeftSquareBracket] = RightSquareBracket;
  balancePair[LeftCurlyBracket] = RightCurlyBracket;
  var blockTokens = new Uint8Array(32);
  blockTokens[Function] = BLOCK_OPEN_TOKEN;
  blockTokens[LeftParenthesis] = BLOCK_OPEN_TOKEN;
  blockTokens[LeftSquareBracket] = BLOCK_OPEN_TOKEN;
  blockTokens[LeftCurlyBracket] = BLOCK_OPEN_TOKEN;
  blockTokens[RightParenthesis] = BLOCK_CLOSE_TOKEN;
  blockTokens[RightSquareBracket] = BLOCK_CLOSE_TOKEN;
  blockTokens[RightCurlyBracket] = BLOCK_CLOSE_TOKEN;
  function boundIndex(index, min, max) {
    return index < min ? min : index > max ? max : index;
  }
  __name(boundIndex, "boundIndex");
  var TokenStream = class {
    static {
      __name(this, "TokenStream");
    }
    constructor(source, tokenize3) {
      this.setSource(source, tokenize3);
    }
    reset() {
      this.eof = false;
      this.tokenIndex = -1;
      this.tokenType = 0;
      this.tokenStart = this.firstCharOffset;
      this.tokenEnd = this.firstCharOffset;
    }
    setSource(source = "", tokenize3 = () => {
    }) {
      source = String(source || "");
      const sourceLength = source.length;
      const offsetAndType = adoptBuffer(this.offsetAndType, source.length + 1);
      const balance = adoptBuffer(this.balance, source.length + 1);
      let tokenCount = 0;
      let firstCharOffset = -1;
      let balanceCloseType = 0;
      let balanceStart = source.length;
      this.offsetAndType = null;
      this.balance = null;
      balance.fill(0);
      tokenize3(source, (type, start, end) => {
        const index = tokenCount++;
        offsetAndType[index] = type << TYPE_SHIFT | end;
        if (firstCharOffset === -1) {
          firstCharOffset = start;
        }
        balance[index] = balanceStart;
        if (type === balanceCloseType) {
          const prevBalanceStart = balance[balanceStart];
          balance[balanceStart] = index;
          balanceStart = prevBalanceStart;
          balanceCloseType = balancePair[offsetAndType[prevBalanceStart] >> TYPE_SHIFT];
        } else if (this.isBlockOpenerTokenType(type)) {
          balanceStart = index;
          balanceCloseType = balancePair[type];
        }
      });
      offsetAndType[tokenCount] = EOF << TYPE_SHIFT | sourceLength;
      balance[tokenCount] = tokenCount;
      for (let i = 0; i < tokenCount; i++) {
        const balanceStart2 = balance[i];
        if (balanceStart2 <= i) {
          const balanceEnd = balance[balanceStart2];
          if (balanceEnd !== i) {
            balance[i] = balanceEnd;
          }
        } else if (balanceStart2 > tokenCount) {
          balance[i] = tokenCount;
        }
      }
      this.source = source;
      this.firstCharOffset = firstCharOffset === -1 ? 0 : firstCharOffset;
      this.tokenCount = tokenCount;
      this.offsetAndType = offsetAndType;
      this.balance = balance;
      this.reset();
      this.next();
    }
    lookupType(offset) {
      offset += this.tokenIndex;
      if (offset < this.tokenCount) {
        return this.offsetAndType[offset] >> TYPE_SHIFT;
      }
      return EOF;
    }
    lookupTypeNonSC(idx) {
      for (let offset = this.tokenIndex; offset < this.tokenCount; offset++) {
        const tokenType = this.offsetAndType[offset] >> TYPE_SHIFT;
        if (tokenType !== WhiteSpace && tokenType !== Comment2) {
          if (idx-- === 0) {
            return tokenType;
          }
        }
      }
      return EOF;
    }
    lookupOffset(offset) {
      offset += this.tokenIndex;
      if (offset < this.tokenCount) {
        return this.offsetAndType[offset - 1] & OFFSET_MASK;
      }
      return this.source.length;
    }
    lookupOffsetNonSC(idx) {
      for (let offset = this.tokenIndex; offset < this.tokenCount; offset++) {
        const tokenType = this.offsetAndType[offset] >> TYPE_SHIFT;
        if (tokenType !== WhiteSpace && tokenType !== Comment2) {
          if (idx-- === 0) {
            return offset - this.tokenIndex;
          }
        }
      }
      return EOF;
    }
    lookupValue(offset, referenceStr) {
      offset += this.tokenIndex;
      if (offset < this.tokenCount) {
        return cmpStr(
          this.source,
          this.offsetAndType[offset - 1] & OFFSET_MASK,
          this.offsetAndType[offset] & OFFSET_MASK,
          referenceStr
        );
      }
      return false;
    }
    getTokenStart(tokenIndex) {
      if (tokenIndex === this.tokenIndex) {
        return this.tokenStart;
      }
      if (tokenIndex > 0) {
        return tokenIndex < this.tokenCount ? this.offsetAndType[tokenIndex - 1] & OFFSET_MASK : this.offsetAndType[this.tokenCount] & OFFSET_MASK;
      }
      return this.firstCharOffset;
    }
    getTokenEnd(tokenIndex) {
      if (tokenIndex === this.tokenIndex) {
        return this.tokenEnd;
      }
      return this.offsetAndType[boundIndex(tokenIndex, 0, this.tokenCount)] & OFFSET_MASK;
    }
    getTokenType(tokenIndex) {
      if (tokenIndex === this.tokenIndex) {
        return this.tokenType;
      }
      return this.offsetAndType[boundIndex(tokenIndex, 0, this.tokenCount)] >> TYPE_SHIFT;
    }
    substrToCursor(start) {
      return this.source.substring(start, this.tokenStart);
    }
    isBlockOpenerTokenType(tokenType) {
      return blockTokens[tokenType] === BLOCK_OPEN_TOKEN;
    }
    isBlockCloserTokenType(tokenType) {
      return blockTokens[tokenType] === BLOCK_CLOSE_TOKEN;
    }
    getBlockTokenPairIndex(tokenIndex) {
      const type = this.getTokenType(tokenIndex);
      if (blockTokens[type] === 1) {
        const pairIndex = this.balance[tokenIndex];
        const closeType = this.getTokenType(pairIndex);
        return balancePair[type] === closeType ? pairIndex : -1;
      } else if (blockTokens[type] === 2) {
        const pairIndex = this.balance[tokenIndex];
        const openType = this.getTokenType(pairIndex);
        return balancePair[openType] === type ? pairIndex : -1;
      }
      return -1;
    }
    isBalanceEdge(tokenIndex) {
      return this.balance[this.tokenIndex] < tokenIndex;
    }
    isDelim(code2, offset) {
      if (offset) {
        return this.lookupType(offset) === Delim && this.source.charCodeAt(this.lookupOffset(offset)) === code2;
      }
      return this.tokenType === Delim && this.source.charCodeAt(this.tokenStart) === code2;
    }
    skip(tokenCount) {
      let next = this.tokenIndex + tokenCount;
      if (next < this.tokenCount) {
        this.tokenIndex = next;
        this.tokenStart = this.offsetAndType[next - 1] & OFFSET_MASK;
        next = this.offsetAndType[next];
        this.tokenType = next >> TYPE_SHIFT;
        this.tokenEnd = next & OFFSET_MASK;
      } else {
        this.tokenIndex = this.tokenCount;
        this.next();
      }
    }
    next() {
      let next = this.tokenIndex + 1;
      if (next < this.tokenCount) {
        this.tokenIndex = next;
        this.tokenStart = this.tokenEnd;
        next = this.offsetAndType[next];
        this.tokenType = next >> TYPE_SHIFT;
        this.tokenEnd = next & OFFSET_MASK;
      } else {
        this.eof = true;
        this.tokenIndex = this.tokenCount;
        this.tokenType = EOF;
        this.tokenStart = this.tokenEnd = this.source.length;
      }
    }
    skipSC() {
      while (this.tokenType === WhiteSpace || this.tokenType === Comment2) {
        this.next();
      }
    }
    skipUntilBalanced(startToken, stopConsume) {
      let cursor = startToken;
      let balanceEnd = 0;
      let offset = 0;
      loop:
        for (; cursor < this.tokenCount; cursor++) {
          balanceEnd = this.balance[cursor];
          if (balanceEnd < startToken) {
            break loop;
          }
          offset = cursor > 0 ? this.offsetAndType[cursor - 1] & OFFSET_MASK : this.firstCharOffset;
          switch (stopConsume(this.source.charCodeAt(offset))) {
            case 1:
              break loop;
            case 2:
              cursor++;
              break loop;
            default:
              if (this.isBlockOpenerTokenType(this.offsetAndType[cursor] >> TYPE_SHIFT)) {
                cursor = balanceEnd;
              }
          }
        }
      this.skip(cursor - this.tokenIndex);
    }
    forEachToken(fn) {
      for (let i = 0, offset = this.firstCharOffset; i < this.tokenCount; i++) {
        const start = offset;
        const item = this.offsetAndType[i];
        const end = item & OFFSET_MASK;
        const type = item >> TYPE_SHIFT;
        offset = end;
        fn(type, start, end, i);
      }
    }
    dump() {
      const tokens = new Array(this.tokenCount);
      this.forEachToken((type, start, end, index) => {
        tokens[index] = {
          idx: index,
          type: names_default[type],
          chunk: this.source.substring(start, end),
          balance: this.balance[index]
        };
      });
      return tokens;
    }
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/tokenizer/index.js
  function tokenize2(source, onToken) {
    function getCharCode2(offset2) {
      return offset2 < sourceLength ? source.charCodeAt(offset2) : 0;
    }
    __name(getCharCode2, "getCharCode");
    function consumeNumericToken() {
      offset = consumeNumber(source, offset);
      if (isIdentifierStart(getCharCode2(offset), getCharCode2(offset + 1), getCharCode2(offset + 2))) {
        type = Dimension;
        offset = consumeName(source, offset);
        return;
      }
      if (getCharCode2(offset) === 37) {
        type = Percentage;
        offset++;
        return;
      }
      type = Number2;
    }
    __name(consumeNumericToken, "consumeNumericToken");
    function consumeIdentLikeToken() {
      const nameStartOffset = offset;
      offset = consumeName(source, offset);
      if (cmpStr(source, nameStartOffset, offset, "url") && getCharCode2(offset) === 40) {
        offset = findWhiteSpaceEnd(source, offset + 1);
        if (getCharCode2(offset) === 34 || getCharCode2(offset) === 39) {
          type = Function;
          offset = nameStartOffset + 4;
          return;
        }
        consumeUrlToken();
        return;
      }
      if (getCharCode2(offset) === 40) {
        type = Function;
        offset++;
        return;
      }
      type = Ident;
    }
    __name(consumeIdentLikeToken, "consumeIdentLikeToken");
    function consumeStringToken(endingCodePoint) {
      if (!endingCodePoint) {
        endingCodePoint = getCharCode2(offset++);
      }
      type = String2;
      for (; offset < source.length; offset++) {
        const code2 = source.charCodeAt(offset);
        switch (charCodeCategory(code2)) {
          // ending code point
          case endingCodePoint:
            offset++;
            return;
          // EOF
          // case EofCategory:
          // This is a parse error. Return the <string-token>.
          // return;
          // newline
          case WhiteSpaceCategory:
            if (isNewline(code2)) {
              offset += getNewlineLength(source, offset, code2);
              type = BadString;
              return;
            }
            break;
          // U+005C REVERSE SOLIDUS (\)
          case 92:
            if (offset === source.length - 1) {
              break;
            }
            const nextCode = getCharCode2(offset + 1);
            if (isNewline(nextCode)) {
              offset += getNewlineLength(source, offset + 1, nextCode);
            } else if (isValidEscape(code2, nextCode)) {
              offset = consumeEscaped(source, offset) - 1;
            }
            break;
        }
      }
    }
    __name(consumeStringToken, "consumeStringToken");
    function consumeUrlToken() {
      type = Url;
      offset = findWhiteSpaceEnd(source, offset);
      for (; offset < source.length; offset++) {
        const code2 = source.charCodeAt(offset);
        switch (charCodeCategory(code2)) {
          // U+0029 RIGHT PARENTHESIS ())
          case 41:
            offset++;
            return;
          // EOF
          // case EofCategory:
          // This is a parse error. Return the <url-token>.
          // return;
          // whitespace
          case WhiteSpaceCategory:
            offset = findWhiteSpaceEnd(source, offset);
            if (getCharCode2(offset) === 41 || offset >= source.length) {
              if (offset < source.length) {
                offset++;
              }
              return;
            }
            offset = consumeBadUrlRemnants(source, offset);
            type = BadUrl;
            return;
          // U+0022 QUOTATION MARK (")
          // U+0027 APOSTROPHE (')
          // U+0028 LEFT PARENTHESIS (()
          // non-printable code point
          case 34:
          case 39:
          case 40:
          case NonPrintableCategory:
            offset = consumeBadUrlRemnants(source, offset);
            type = BadUrl;
            return;
          // U+005C REVERSE SOLIDUS (\)
          case 92:
            if (isValidEscape(code2, getCharCode2(offset + 1))) {
              offset = consumeEscaped(source, offset) - 1;
              break;
            }
            offset = consumeBadUrlRemnants(source, offset);
            type = BadUrl;
            return;
        }
      }
    }
    __name(consumeUrlToken, "consumeUrlToken");
    source = String(source || "");
    const sourceLength = source.length;
    let start = isBOM(getCharCode2(0));
    let offset = start;
    let type;
    while (offset < sourceLength) {
      const code2 = source.charCodeAt(offset);
      switch (charCodeCategory(code2)) {
        // whitespace
        case WhiteSpaceCategory:
          type = WhiteSpace;
          offset = findWhiteSpaceEnd(source, offset + 1);
          break;
        // U+0022 QUOTATION MARK (")
        case 34:
          consumeStringToken();
          break;
        // U+0023 NUMBER SIGN (#)
        case 35:
          if (isName(getCharCode2(offset + 1)) || isValidEscape(getCharCode2(offset + 1), getCharCode2(offset + 2))) {
            type = Hash;
            offset = consumeName(source, offset + 1);
          } else {
            type = Delim;
            offset++;
          }
          break;
        // U+0027 APOSTROPHE (')
        case 39:
          consumeStringToken();
          break;
        // U+0028 LEFT PARENTHESIS (()
        case 40:
          type = LeftParenthesis;
          offset++;
          break;
        // U+0029 RIGHT PARENTHESIS ())
        case 41:
          type = RightParenthesis;
          offset++;
          break;
        // U+002B PLUS SIGN (+)
        case 43:
          if (isNumberStart(code2, getCharCode2(offset + 1), getCharCode2(offset + 2))) {
            consumeNumericToken();
          } else {
            type = Delim;
            offset++;
          }
          break;
        // U+002C COMMA (,)
        case 44:
          type = Comma;
          offset++;
          break;
        // U+002D HYPHEN-MINUS (-)
        case 45:
          if (isNumberStart(code2, getCharCode2(offset + 1), getCharCode2(offset + 2))) {
            consumeNumericToken();
          } else {
            if (getCharCode2(offset + 1) === 45 && getCharCode2(offset + 2) === 62) {
              type = CDC;
              offset = offset + 3;
            } else {
              if (isIdentifierStart(code2, getCharCode2(offset + 1), getCharCode2(offset + 2))) {
                consumeIdentLikeToken();
              } else {
                type = Delim;
                offset++;
              }
            }
          }
          break;
        // U+002E FULL STOP (.)
        case 46:
          if (isNumberStart(code2, getCharCode2(offset + 1), getCharCode2(offset + 2))) {
            consumeNumericToken();
          } else {
            type = Delim;
            offset++;
          }
          break;
        // U+002F SOLIDUS (/)
        case 47:
          if (getCharCode2(offset + 1) === 42) {
            type = Comment2;
            offset = source.indexOf("*/", offset + 2);
            offset = offset === -1 ? source.length : offset + 2;
          } else {
            type = Delim;
            offset++;
          }
          break;
        // U+003A COLON (:)
        case 58:
          type = Colon;
          offset++;
          break;
        // U+003B SEMICOLON (;)
        case 59:
          type = Semicolon;
          offset++;
          break;
        // U+003C LESS-THAN SIGN (<)
        case 60:
          if (getCharCode2(offset + 1) === 33 && getCharCode2(offset + 2) === 45 && getCharCode2(offset + 3) === 45) {
            type = CDO;
            offset = offset + 4;
          } else {
            type = Delim;
            offset++;
          }
          break;
        // U+0040 COMMERCIAL AT (@)
        case 64:
          if (isIdentifierStart(getCharCode2(offset + 1), getCharCode2(offset + 2), getCharCode2(offset + 3))) {
            type = AtKeyword;
            offset = consumeName(source, offset + 1);
          } else {
            type = Delim;
            offset++;
          }
          break;
        // U+005B LEFT SQUARE BRACKET ([)
        case 91:
          type = LeftSquareBracket;
          offset++;
          break;
        // U+005C REVERSE SOLIDUS (\)
        case 92:
          if (isValidEscape(code2, getCharCode2(offset + 1))) {
            consumeIdentLikeToken();
          } else {
            type = Delim;
            offset++;
          }
          break;
        // U+005D RIGHT SQUARE BRACKET (])
        case 93:
          type = RightSquareBracket;
          offset++;
          break;
        // U+007B LEFT CURLY BRACKET ({)
        case 123:
          type = LeftCurlyBracket;
          offset++;
          break;
        // U+007D RIGHT CURLY BRACKET (})
        case 125:
          type = RightCurlyBracket;
          offset++;
          break;
        // digit
        case DigitCategory:
          consumeNumericToken();
          break;
        // name-start code point
        case NameStartCategory:
          consumeIdentLikeToken();
          break;
        // EOF
        // case EofCategory:
        // Return an <EOF-token>.
        // break;
        // anything else
        default:
          type = Delim;
          offset++;
      }
      onToken(type, start, start = offset);
    }
  }
  __name(tokenize2, "tokenize");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/parser/sequence.js
  function readSequence(recognizer) {
    const children = this.createList();
    let space = false;
    const context = {
      recognizer
    };
    while (!this.eof) {
      switch (this.tokenType) {
        case Comment2:
          this.next();
          continue;
        case WhiteSpace:
          space = true;
          this.next();
          continue;
      }
      let child = recognizer.getNode.call(this, context);
      if (child === void 0) {
        break;
      }
      if (space) {
        if (recognizer.onWhiteSpace) {
          recognizer.onWhiteSpace.call(this, child, children, context);
        }
        space = false;
      }
      children.push(child);
    }
    if (space && recognizer.onWhiteSpace) {
      recognizer.onWhiteSpace.call(this, null, children, context);
    }
    return children;
  }
  __name(readSequence, "readSequence");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/parser/create.js
  var NOOP = /* @__PURE__ */ __name(() => {
  }, "NOOP");
  var EXCLAMATIONMARK = 33;
  var NUMBERSIGN = 35;
  var SEMICOLON = 59;
  var LEFTCURLYBRACKET = 123;
  var NULL = 0;
  var arrayMethods = {
    createList() {
      return [];
    },
    createSingleNodeList(node) {
      return [node];
    },
    getFirstListNode(list) {
      return list && list[0] || null;
    },
    getLastListNode(list) {
      return list && list.length > 0 ? list[list.length - 1] : null;
    }
  };
  var listMethods = {
    createList() {
      return new List();
    },
    createSingleNodeList(node) {
      return new List().appendData(node);
    },
    getFirstListNode(list) {
      return list && list.first;
    },
    getLastListNode(list) {
      return list && list.last;
    }
  };
  function createParseContext(name50) {
    return function() {
      return this[name50]();
    };
  }
  __name(createParseContext, "createParseContext");
  function fetchParseValues(dict) {
    const result = /* @__PURE__ */ Object.create(null);
    for (const name50 of Object.keys(dict)) {
      const item = dict[name50];
      const fn = item.parse || item;
      if (fn) {
        result[name50] = fn;
      }
    }
    return result;
  }
  __name(fetchParseValues, "fetchParseValues");
  function processConfig(config) {
    const parseConfig = {
      context: /* @__PURE__ */ Object.create(null),
      features: Object.assign(/* @__PURE__ */ Object.create(null), config.features),
      scope: Object.assign(/* @__PURE__ */ Object.create(null), config.scope),
      atrule: fetchParseValues(config.atrule),
      pseudo: fetchParseValues(config.pseudo),
      node: fetchParseValues(config.node)
    };
    for (const [name50, context] of Object.entries(config.parseContext)) {
      switch (typeof context) {
        case "function":
          parseConfig.context[name50] = context;
          break;
        case "string":
          parseConfig.context[name50] = createParseContext(context);
          break;
      }
    }
    return {
      config: parseConfig,
      ...parseConfig,
      ...parseConfig.node
    };
  }
  __name(processConfig, "processConfig");
  function createParser(config) {
    let source = "";
    let filename = "<unknown>";
    let needPositions = false;
    let onParseError = NOOP;
    let onParseErrorThrow = false;
    const locationMap = new OffsetToLocation();
    const parser = Object.assign(new TokenStream(), processConfig(config || {}), {
      parseAtrulePrelude: true,
      parseRulePrelude: true,
      parseValue: true,
      parseCustomProperty: false,
      readSequence,
      consumeUntilBalanceEnd: /* @__PURE__ */ __name(() => 0, "consumeUntilBalanceEnd"),
      consumeUntilLeftCurlyBracket(code2) {
        return code2 === LEFTCURLYBRACKET ? 1 : 0;
      },
      consumeUntilLeftCurlyBracketOrSemicolon(code2) {
        return code2 === LEFTCURLYBRACKET || code2 === SEMICOLON ? 1 : 0;
      },
      consumeUntilExclamationMarkOrSemicolon(code2) {
        return code2 === EXCLAMATIONMARK || code2 === SEMICOLON ? 1 : 0;
      },
      consumeUntilSemicolonIncluded(code2) {
        return code2 === SEMICOLON ? 2 : 0;
      },
      createList: NOOP,
      createSingleNodeList: NOOP,
      getFirstListNode: NOOP,
      getLastListNode: NOOP,
      parseWithFallback(consumer, fallback) {
        const startIndex = this.tokenIndex;
        try {
          return consumer.call(this);
        } catch (e) {
          if (onParseErrorThrow) {
            throw e;
          }
          this.skip(startIndex - this.tokenIndex);
          const fallbackNode = fallback.call(this);
          onParseErrorThrow = true;
          onParseError(e, fallbackNode);
          onParseErrorThrow = false;
          return fallbackNode;
        }
      },
      lookupNonWSType(offset) {
        let type;
        do {
          type = this.lookupType(offset++);
          if (type !== WhiteSpace && type !== Comment2) {
            return type;
          }
        } while (type !== NULL);
        return NULL;
      },
      charCodeAt(offset) {
        return offset >= 0 && offset < source.length ? source.charCodeAt(offset) : 0;
      },
      substring(offsetStart, offsetEnd) {
        return source.substring(offsetStart, offsetEnd);
      },
      substrToCursor(start) {
        return this.source.substring(start, this.tokenStart);
      },
      cmpChar(offset, charCode) {
        return cmpChar(source, offset, charCode);
      },
      cmpStr(offsetStart, offsetEnd, str) {
        return cmpStr(source, offsetStart, offsetEnd, str);
      },
      consume(tokenType) {
        const start = this.tokenStart;
        this.eat(tokenType);
        return this.substrToCursor(start);
      },
      consumeFunctionName() {
        const name50 = source.substring(this.tokenStart, this.tokenEnd - 1);
        this.eat(Function);
        return name50;
      },
      consumeNumber(type) {
        const number = source.substring(this.tokenStart, consumeNumber(source, this.tokenStart));
        this.eat(type);
        return number;
      },
      eat(tokenType) {
        if (this.tokenType !== tokenType) {
          const tokenName = names_default[tokenType].slice(0, -6).replace(/-/g, " ").replace(/^./, (m) => m.toUpperCase());
          let message = `${/[[\](){}]/.test(tokenName) ? `"${tokenName}"` : tokenName} is expected`;
          let offset = this.tokenStart;
          switch (tokenType) {
            case Ident:
              if (this.tokenType === Function || this.tokenType === Url) {
                offset = this.tokenEnd - 1;
                message = "Identifier is expected but function found";
              } else {
                message = "Identifier is expected";
              }
              break;
            case Hash:
              if (this.isDelim(NUMBERSIGN)) {
                this.next();
                offset++;
                message = "Name is expected";
              }
              break;
            case Percentage:
              if (this.tokenType === Number2) {
                offset = this.tokenEnd;
                message = "Percent sign is expected";
              }
              break;
          }
          this.error(message, offset);
        }
        this.next();
      },
      eatIdent(name50) {
        if (this.tokenType !== Ident || this.lookupValue(0, name50) === false) {
          this.error(`Identifier "${name50}" is expected`);
        }
        this.next();
      },
      eatDelim(code2) {
        if (!this.isDelim(code2)) {
          this.error(`Delim "${String.fromCharCode(code2)}" is expected`);
        }
        this.next();
      },
      getLocation(start, end) {
        if (needPositions) {
          return locationMap.getLocationRange(
            start,
            end,
            filename
          );
        }
        return null;
      },
      getLocationFromList(list) {
        if (needPositions) {
          const head = this.getFirstListNode(list);
          const tail = this.getLastListNode(list);
          return locationMap.getLocationRange(
            head !== null ? head.loc.start.offset - locationMap.startOffset : this.tokenStart,
            tail !== null ? tail.loc.end.offset - locationMap.startOffset : this.tokenStart,
            filename
          );
        }
        return null;
      },
      error(message, offset) {
        const location = typeof offset !== "undefined" && offset < source.length ? locationMap.getLocation(offset) : this.eof ? locationMap.getLocation(findWhiteSpaceStart(source, source.length - 1)) : locationMap.getLocation(this.tokenStart);
        throw new SyntaxError2(
          message || "Unexpected input",
          source,
          location.offset,
          location.line,
          location.column,
          locationMap.startLine,
          locationMap.startColumn
        );
      }
    });
    const createTokenIterateAPI = /* @__PURE__ */ __name(() => ({
      filename,
      source,
      tokenCount: parser.tokenCount,
      getTokenType: /* @__PURE__ */ __name((index) => parser.getTokenType(index), "getTokenType"),
      getTokenTypeName: /* @__PURE__ */ __name((index) => names_default[parser.getTokenType(index)], "getTokenTypeName"),
      getTokenStart: /* @__PURE__ */ __name((index) => parser.getTokenStart(index), "getTokenStart"),
      getTokenEnd: /* @__PURE__ */ __name((index) => parser.getTokenEnd(index), "getTokenEnd"),
      getTokenValue: /* @__PURE__ */ __name((index) => parser.source.substring(parser.getTokenStart(index), parser.getTokenEnd(index)), "getTokenValue"),
      substring: /* @__PURE__ */ __name((start, end) => parser.source.substring(start, end), "substring"),
      balance: parser.balance.subarray(0, parser.tokenCount + 1),
      isBlockOpenerTokenType: parser.isBlockOpenerTokenType,
      isBlockCloserTokenType: parser.isBlockCloserTokenType,
      getBlockTokenPairIndex: /* @__PURE__ */ __name((index) => parser.getBlockTokenPairIndex(index), "getBlockTokenPairIndex"),
      getLocation: /* @__PURE__ */ __name((offset) => locationMap.getLocation(offset, filename), "getLocation"),
      getRangeLocation: /* @__PURE__ */ __name((start, end) => locationMap.getLocationRange(start, end, filename), "getRangeLocation")
    }), "createTokenIterateAPI");
    const parse53 = /* @__PURE__ */ __name(function(source_, options) {
      source = source_;
      options = options || {};
      parser.setSource(source, tokenize2);
      locationMap.setSource(
        source,
        options.offset,
        options.line,
        options.column
      );
      filename = options.filename || "<unknown>";
      needPositions = Boolean(options.positions);
      onParseError = typeof options.onParseError === "function" ? options.onParseError : NOOP;
      onParseErrorThrow = false;
      parser.parseAtrulePrelude = "parseAtrulePrelude" in options ? Boolean(options.parseAtrulePrelude) : true;
      parser.parseRulePrelude = "parseRulePrelude" in options ? Boolean(options.parseRulePrelude) : true;
      parser.parseValue = "parseValue" in options ? Boolean(options.parseValue) : true;
      parser.parseCustomProperty = "parseCustomProperty" in options ? Boolean(options.parseCustomProperty) : false;
      const { context = "default", list = true, onComment, onToken } = options;
      if (context in parser.context === false) {
        throw new Error("Unknown context `" + context + "`");
      }
      Object.assign(parser, list ? listMethods : arrayMethods);
      if (Array.isArray(onToken)) {
        parser.forEachToken((type, start, end) => {
          onToken.push({ type, start, end });
        });
      } else if (typeof onToken === "function") {
        parser.forEachToken(onToken.bind(createTokenIterateAPI()));
      }
      if (typeof onComment === "function") {
        parser.forEachToken((type, start, end) => {
          if (type === Comment2) {
            const loc = parser.getLocation(start, end);
            const value = cmpStr(source, end - 2, end, "*/") ? source.slice(start + 2, end - 2) : source.slice(start + 2, end);
            onComment(value, loc);
          }
        });
      }
      const ast = parser.context[context].call(parser, options);
      if (!parser.eof) {
        parser.error();
      }
      return ast;
    }, "parse");
    return Object.assign(parse53, {
      SyntaxError: SyntaxError2,
      config: parser.config
    });
  }
  __name(createParser, "createParser");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/scope/index.js
  var scope_exports = {};
  __export(scope_exports, {
    AtrulePrelude: () => atrulePrelude_default,
    Selector: () => selector_default,
    Value: () => value_default
  });

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/scope/default.js
  var NUMBERSIGN2 = 35;
  var ASTERISK = 42;
  var PLUSSIGN = 43;
  var HYPHENMINUS = 45;
  var SOLIDUS = 47;
  var U = 117;
  function defaultRecognizer(context) {
    switch (this.tokenType) {
      case Hash:
        return this.Hash();
      case Comma:
        return this.Operator();
      case LeftParenthesis:
        return this.Parentheses(this.readSequence, context.recognizer);
      case LeftSquareBracket:
        return this.Brackets(this.readSequence, context.recognizer);
      case String2:
        return this.String();
      case Dimension:
        return this.Dimension();
      case Percentage:
        return this.Percentage();
      case Number2:
        return this.Number();
      case Function:
        return this.cmpStr(this.tokenStart, this.tokenEnd, "url(") ? this.Url() : this.Function(this.readSequence, context.recognizer);
      case Url:
        return this.Url();
      case Ident:
        if (this.cmpChar(this.tokenStart, U) && this.cmpChar(this.tokenStart + 1, PLUSSIGN)) {
          return this.UnicodeRange();
        } else {
          return this.Identifier();
        }
      case Delim: {
        const code2 = this.charCodeAt(this.tokenStart);
        if (code2 === SOLIDUS || code2 === ASTERISK || code2 === PLUSSIGN || code2 === HYPHENMINUS) {
          return this.Operator();
        }
        if (code2 === NUMBERSIGN2) {
          this.error("Hex or identifier is expected", this.tokenStart + 1);
        }
        break;
      }
    }
  }
  __name(defaultRecognizer, "defaultRecognizer");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/scope/atrulePrelude.js
  var atrulePrelude_default = {
    getNode: defaultRecognizer
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/scope/selector.js
  var NUMBERSIGN3 = 35;
  var AMPERSAND = 38;
  var ASTERISK2 = 42;
  var PLUSSIGN2 = 43;
  var SOLIDUS2 = 47;
  var FULLSTOP = 46;
  var GREATERTHANSIGN = 62;
  var VERTICALLINE = 124;
  var TILDE = 126;
  function onWhiteSpace(next, children) {
    if (children.last !== null && children.last.type !== "Combinator" && next !== null && next.type !== "Combinator") {
      children.push({
        // FIXME: this.Combinator() should be used instead
        type: "Combinator",
        loc: null,
        name: " "
      });
    }
  }
  __name(onWhiteSpace, "onWhiteSpace");
  function getNode() {
    switch (this.tokenType) {
      case LeftSquareBracket:
        return this.AttributeSelector();
      case Hash:
        return this.IdSelector();
      case Colon:
        if (this.lookupType(1) === Colon) {
          return this.PseudoElementSelector();
        } else {
          return this.PseudoClassSelector();
        }
      case Ident:
        return this.TypeSelector();
      case Number2:
      case Percentage:
        return this.Percentage();
      case Dimension:
        if (this.charCodeAt(this.tokenStart) === FULLSTOP) {
          this.error("Identifier is expected", this.tokenStart + 1);
        }
        break;
      case Delim: {
        const code2 = this.charCodeAt(this.tokenStart);
        switch (code2) {
          case PLUSSIGN2:
          case GREATERTHANSIGN:
          case TILDE:
          case SOLIDUS2:
            return this.Combinator();
          case FULLSTOP:
            return this.ClassSelector();
          case ASTERISK2:
          case VERTICALLINE:
            return this.TypeSelector();
          case NUMBERSIGN3:
            return this.IdSelector();
          case AMPERSAND:
            return this.NestingSelector();
        }
        break;
      }
    }
  }
  __name(getNode, "getNode");
  var selector_default = {
    onWhiteSpace,
    getNode
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/function/expression.js
  function expression_default() {
    return this.createSingleNodeList(
      this.Raw(null, false)
    );
  }
  __name(expression_default, "default");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/function/var.js
  function var_default() {
    const children = this.createList();
    this.skipSC();
    children.push(this.Identifier());
    this.skipSC();
    if (this.tokenType === Comma) {
      children.push(this.Operator());
      const startIndex = this.tokenIndex;
      const value = this.parseCustomProperty ? this.Value(null) : this.Raw(this.consumeUntilExclamationMarkOrSemicolon, false);
      if (value.type === "Value" && value.children.isEmpty) {
        for (let offset = startIndex - this.tokenIndex; offset <= 0; offset++) {
          if (this.lookupType(offset) === WhiteSpace) {
            value.children.appendData({
              type: "WhiteSpace",
              loc: null,
              value: " "
            });
            break;
          }
        }
      }
      children.push(value);
    }
    return children;
  }
  __name(var_default, "default");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/scope/value.js
  function isPlusMinusOperator(node) {
    return node !== null && node.type === "Operator" && (node.value[node.value.length - 1] === "-" || node.value[node.value.length - 1] === "+");
  }
  __name(isPlusMinusOperator, "isPlusMinusOperator");
  var value_default = {
    getNode: defaultRecognizer,
    onWhiteSpace(next, children) {
      if (isPlusMinusOperator(next)) {
        next.value = " " + next.value;
      }
      if (isPlusMinusOperator(children.last)) {
        children.last.value += " ";
      }
    },
    "expression": expression_default,
    "var": var_default
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/atrule/container.js
  var nonContainerNameKeywords = /* @__PURE__ */ new Set(["none", "and", "not", "or"]);
  var container_default = {
    parse: {
      prelude() {
        const children = this.createList();
        if (this.tokenType === Ident) {
          const name50 = this.substring(this.tokenStart, this.tokenEnd);
          if (!nonContainerNameKeywords.has(name50.toLowerCase())) {
            children.push(this.Identifier());
          }
        }
        children.push(this.Condition("container"));
        return children;
      },
      block(nested = false) {
        return this.Block(nested);
      }
    }
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/atrule/font-face.js
  var font_face_default = {
    parse: {
      prelude: null,
      block() {
        return this.Block(true);
      }
    }
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/atrule/import.js
  function parseWithFallback(parse53, fallback) {
    return this.parseWithFallback(
      () => {
        try {
          return parse53.call(this);
        } finally {
          this.skipSC();
          if (this.lookupNonWSType(0) !== RightParenthesis) {
            this.error();
          }
        }
      },
      fallback || (() => this.Raw(null, true))
    );
  }
  __name(parseWithFallback, "parseWithFallback");
  var parseFunctions = {
    layer() {
      this.skipSC();
      const children = this.createList();
      const node = parseWithFallback.call(this, this.Layer);
      if (node.type !== "Raw" || node.value !== "") {
        children.push(node);
      }
      return children;
    },
    supports() {
      this.skipSC();
      const children = this.createList();
      const node = parseWithFallback.call(
        this,
        this.Declaration,
        () => parseWithFallback.call(this, () => this.Condition("supports"))
      );
      if (node.type !== "Raw" || node.value !== "") {
        children.push(node);
      }
      return children;
    }
  };
  var import_default3 = {
    parse: {
      prelude() {
        const children = this.createList();
        switch (this.tokenType) {
          case String2:
            children.push(this.String());
            break;
          case Url:
          case Function:
            children.push(this.Url());
            break;
          default:
            this.error("String or url() is expected");
        }
        this.skipSC();
        if (this.tokenType === Ident && this.cmpStr(this.tokenStart, this.tokenEnd, "layer")) {
          children.push(this.Identifier());
        } else if (this.tokenType === Function && this.cmpStr(this.tokenStart, this.tokenEnd, "layer(")) {
          children.push(this.Function(null, parseFunctions));
        }
        this.skipSC();
        if (this.tokenType === Function && this.cmpStr(this.tokenStart, this.tokenEnd, "supports(")) {
          children.push(this.Function(null, parseFunctions));
        }
        if (this.lookupNonWSType(0) === Ident || this.lookupNonWSType(0) === LeftParenthesis) {
          children.push(this.MediaQueryList());
        }
        return children;
      },
      block: null
    }
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/atrule/layer.js
  var layer_default = {
    parse: {
      prelude() {
        return this.createSingleNodeList(
          this.LayerList()
        );
      },
      block() {
        return this.Block(false);
      }
    }
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/atrule/media.js
  var media_default = {
    parse: {
      prelude() {
        return this.createSingleNodeList(
          this.MediaQueryList()
        );
      },
      block(nested = false) {
        return this.Block(nested);
      }
    }
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/atrule/nest.js
  var nest_default = {
    parse: {
      prelude() {
        return this.createSingleNodeList(
          this.SelectorList()
        );
      },
      block() {
        return this.Block(true);
      }
    }
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/atrule/page.js
  var page_default = {
    parse: {
      prelude() {
        return this.createSingleNodeList(
          this.SelectorList()
        );
      },
      block() {
        return this.Block(true);
      }
    }
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/atrule/scope.js
  var scope_default = {
    parse: {
      prelude() {
        return this.createSingleNodeList(
          this.Scope()
        );
      },
      block(nested = false) {
        return this.Block(nested);
      }
    }
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/atrule/starting-style.js
  var starting_style_default = {
    parse: {
      prelude: null,
      block(nested = false) {
        return this.Block(nested);
      }
    }
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/atrule/supports.js
  var supports_default = {
    parse: {
      prelude() {
        return this.createSingleNodeList(
          this.Condition("supports")
        );
      },
      block(nested = false) {
        return this.Block(nested);
      }
    }
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/atrule/index.js
  var atrule_default = {
    container: container_default,
    "font-face": font_face_default,
    import: import_default3,
    layer: layer_default,
    media: media_default,
    nest: nest_default,
    page: page_default,
    scope: scope_default,
    "starting-style": starting_style_default,
    supports: supports_default
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/pseudo/lang.js
  function parseLanguageRangeList() {
    const children = this.createList();
    this.skipSC();
    loop: while (!this.eof) {
      switch (this.tokenType) {
        case Ident:
          children.push(this.Identifier());
          break;
        case String2:
          children.push(this.String());
          break;
        case Comma:
          children.push(this.Operator());
          break;
        case RightParenthesis:
          break loop;
        default:
          this.error("Identifier, string or comma is expected");
      }
      this.skipSC();
    }
    return children;
  }
  __name(parseLanguageRangeList, "parseLanguageRangeList");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/pseudo/index.js
  var selectorList = {
    parse() {
      return this.createSingleNodeList(
        this.SelectorList()
      );
    }
  };
  var selector = {
    parse() {
      return this.createSingleNodeList(
        this.Selector()
      );
    }
  };
  var identList = {
    parse() {
      return this.createSingleNodeList(
        this.Identifier()
      );
    }
  };
  var langList = {
    parse: parseLanguageRangeList
  };
  var nth = {
    parse() {
      return this.createSingleNodeList(
        this.Nth()
      );
    }
  };
  var pseudo_default = {
    "dir": identList,
    "has": selectorList,
    "lang": langList,
    "matches": selectorList,
    "is": selectorList,
    "-moz-any": selectorList,
    "-webkit-any": selectorList,
    "where": selectorList,
    "not": selectorList,
    "nth-child": nth,
    "nth-last-child": nth,
    "nth-last-of-type": nth,
    "nth-of-type": nth,
    "slotted": selector,
    "host": selector,
    "host-context": selector
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/index-parse.js
  var index_parse_exports = {};
  __export(index_parse_exports, {
    AnPlusB: () => parse4,
    Atrule: () => parse5,
    AtrulePrelude: () => parse6,
    AttributeSelector: () => parse7,
    Block: () => parse8,
    Brackets: () => parse9,
    CDC: () => parse10,
    CDO: () => parse11,
    ClassSelector: () => parse12,
    Combinator: () => parse13,
    Comment: () => parse14,
    Condition: () => parse15,
    Declaration: () => parse16,
    DeclarationList: () => parse17,
    Dimension: () => parse18,
    Feature: () => parse19,
    FeatureFunction: () => parse20,
    FeatureRange: () => parse21,
    Function: () => parse22,
    GeneralEnclosed: () => parse23,
    Hash: () => parse24,
    IdSelector: () => parse26,
    Identifier: () => parse25,
    Layer: () => parse27,
    LayerList: () => parse28,
    MediaQuery: () => parse29,
    MediaQueryList: () => parse30,
    NestingSelector: () => parse31,
    Nth: () => parse32,
    Number: () => parse33,
    Operator: () => parse34,
    Parentheses: () => parse35,
    Percentage: () => parse36,
    PseudoClassSelector: () => parse37,
    PseudoElementSelector: () => parse38,
    Ratio: () => parse39,
    Raw: () => parse40,
    Rule: () => parse41,
    Scope: () => parse42,
    Selector: () => parse43,
    SelectorList: () => parse44,
    String: () => parse45,
    StyleSheet: () => parse46,
    SupportsDeclaration: () => parse47,
    TypeSelector: () => parse48,
    UnicodeRange: () => parse49,
    Url: () => parse50,
    Value: () => parse51,
    WhiteSpace: () => parse52
  });

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/AnPlusB.js
  var AnPlusB_exports = {};
  __export(AnPlusB_exports, {
    generate: () => generate2,
    name: () => name,
    parse: () => parse4,
    structure: () => structure
  });
  var PLUSSIGN3 = 43;
  var HYPHENMINUS2 = 45;
  var N2 = 110;
  var DISALLOW_SIGN = true;
  var ALLOW_SIGN = false;
  function checkInteger(offset, disallowSign) {
    let pos = this.tokenStart + offset;
    const code2 = this.charCodeAt(pos);
    if (code2 === PLUSSIGN3 || code2 === HYPHENMINUS2) {
      if (disallowSign) {
        this.error("Number sign is not allowed");
      }
      pos++;
    }
    for (; pos < this.tokenEnd; pos++) {
      if (!isDigit2(this.charCodeAt(pos))) {
        this.error("Integer is expected", pos);
      }
    }
  }
  __name(checkInteger, "checkInteger");
  function checkTokenIsInteger(disallowSign) {
    return checkInteger.call(this, 0, disallowSign);
  }
  __name(checkTokenIsInteger, "checkTokenIsInteger");
  function expectCharCode(offset, code2) {
    if (!this.cmpChar(this.tokenStart + offset, code2)) {
      let msg = "";
      switch (code2) {
        case N2:
          msg = "N is expected";
          break;
        case HYPHENMINUS2:
          msg = "HyphenMinus is expected";
          break;
      }
      this.error(msg, this.tokenStart + offset);
    }
  }
  __name(expectCharCode, "expectCharCode");
  function consumeB() {
    let offset = 0;
    let sign = 0;
    let type = this.tokenType;
    while (type === WhiteSpace || type === Comment2) {
      type = this.lookupType(++offset);
    }
    if (type !== Number2) {
      if (this.isDelim(PLUSSIGN3, offset) || this.isDelim(HYPHENMINUS2, offset)) {
        sign = this.isDelim(PLUSSIGN3, offset) ? PLUSSIGN3 : HYPHENMINUS2;
        do {
          type = this.lookupType(++offset);
        } while (type === WhiteSpace || type === Comment2);
        if (type !== Number2) {
          this.skip(offset);
          checkTokenIsInteger.call(this, DISALLOW_SIGN);
        }
      } else {
        return null;
      }
    }
    if (offset > 0) {
      this.skip(offset);
    }
    if (sign === 0) {
      type = this.charCodeAt(this.tokenStart);
      if (type !== PLUSSIGN3 && type !== HYPHENMINUS2) {
        this.error("Number sign is expected");
      }
    }
    checkTokenIsInteger.call(this, sign !== 0);
    return sign === HYPHENMINUS2 ? "-" + this.consume(Number2) : this.consume(Number2);
  }
  __name(consumeB, "consumeB");
  var name = "AnPlusB";
  var structure = {
    a: [String, null],
    b: [String, null]
  };
  function parse4() {
    const start = this.tokenStart;
    let a = null;
    let b = null;
    if (this.tokenType === Number2) {
      checkTokenIsInteger.call(this, ALLOW_SIGN);
      b = this.consume(Number2);
    } else if (this.tokenType === Ident && this.cmpChar(this.tokenStart, HYPHENMINUS2)) {
      a = "-1";
      expectCharCode.call(this, 1, N2);
      switch (this.tokenEnd - this.tokenStart) {
        // -n
        // -n <signed-integer>
        // -n ['+' | '-'] <signless-integer>
        case 2:
          this.next();
          b = consumeB.call(this);
          break;
        // -n- <signless-integer>
        case 3:
          expectCharCode.call(this, 2, HYPHENMINUS2);
          this.next();
          this.skipSC();
          checkTokenIsInteger.call(this, DISALLOW_SIGN);
          b = "-" + this.consume(Number2);
          break;
        // <dashndashdigit-ident>
        default:
          expectCharCode.call(this, 2, HYPHENMINUS2);
          checkInteger.call(this, 3, DISALLOW_SIGN);
          this.next();
          b = this.substrToCursor(start + 2);
      }
    } else if (this.tokenType === Ident || this.isDelim(PLUSSIGN3) && this.lookupType(1) === Ident) {
      let sign = 0;
      a = "1";
      if (this.isDelim(PLUSSIGN3)) {
        sign = 1;
        this.next();
      }
      expectCharCode.call(this, 0, N2);
      switch (this.tokenEnd - this.tokenStart) {
        // '+'? n
        // '+'? n <signed-integer>
        // '+'? n ['+' | '-'] <signless-integer>
        case 1:
          this.next();
          b = consumeB.call(this);
          break;
        // '+'? n- <signless-integer>
        case 2:
          expectCharCode.call(this, 1, HYPHENMINUS2);
          this.next();
          this.skipSC();
          checkTokenIsInteger.call(this, DISALLOW_SIGN);
          b = "-" + this.consume(Number2);
          break;
        // '+'? <ndashdigit-ident>
        default:
          expectCharCode.call(this, 1, HYPHENMINUS2);
          checkInteger.call(this, 2, DISALLOW_SIGN);
          this.next();
          b = this.substrToCursor(start + sign + 1);
      }
    } else if (this.tokenType === Dimension) {
      const code2 = this.charCodeAt(this.tokenStart);
      const sign = code2 === PLUSSIGN3 || code2 === HYPHENMINUS2;
      let i = this.tokenStart + sign;
      for (; i < this.tokenEnd; i++) {
        if (!isDigit2(this.charCodeAt(i))) {
          break;
        }
      }
      if (i === this.tokenStart + sign) {
        this.error("Integer is expected", this.tokenStart + sign);
      }
      expectCharCode.call(this, i - this.tokenStart, N2);
      a = this.substring(start, i);
      if (i + 1 === this.tokenEnd) {
        this.next();
        b = consumeB.call(this);
      } else {
        expectCharCode.call(this, i - this.tokenStart + 1, HYPHENMINUS2);
        if (i + 2 === this.tokenEnd) {
          this.next();
          this.skipSC();
          checkTokenIsInteger.call(this, DISALLOW_SIGN);
          b = "-" + this.consume(Number2);
        } else {
          checkInteger.call(this, i - this.tokenStart + 2, DISALLOW_SIGN);
          this.next();
          b = this.substrToCursor(i + 1);
        }
      }
    } else {
      this.error();
    }
    if (a !== null && a.charCodeAt(0) === PLUSSIGN3) {
      a = a.substr(1);
    }
    if (b !== null && b.charCodeAt(0) === PLUSSIGN3) {
      b = b.substr(1);
    }
    return {
      type: "AnPlusB",
      loc: this.getLocation(start, this.tokenStart),
      a,
      b
    };
  }
  __name(parse4, "parse");
  function generate2(node) {
    if (node.a) {
      const a = node.a === "+1" && "n" || node.a === "1" && "n" || node.a === "-1" && "-n" || node.a + "n";
      if (node.b) {
        const b = node.b[0] === "-" || node.b[0] === "+" ? node.b : "+" + node.b;
        this.tokenize(a + b);
      } else {
        this.tokenize(a);
      }
    } else {
      this.tokenize(node.b);
    }
  }
  __name(generate2, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Atrule.js
  var Atrule_exports = {};
  __export(Atrule_exports, {
    generate: () => generate3,
    name: () => name2,
    parse: () => parse5,
    structure: () => structure2,
    walkContext: () => walkContext
  });
  function consumeRaw() {
    return this.Raw(this.consumeUntilLeftCurlyBracketOrSemicolon, true);
  }
  __name(consumeRaw, "consumeRaw");
  function isDeclarationBlockAtrule() {
    for (let offset = 1, type; type = this.lookupType(offset); offset++) {
      if (type === RightCurlyBracket) {
        return true;
      }
      if (type === LeftCurlyBracket || type === AtKeyword) {
        return false;
      }
    }
    return false;
  }
  __name(isDeclarationBlockAtrule, "isDeclarationBlockAtrule");
  var name2 = "Atrule";
  var walkContext = "atrule";
  var structure2 = {
    name: String,
    prelude: ["AtrulePrelude", "Raw", null],
    block: ["Block", null]
  };
  function parse5(isDeclaration = false) {
    const start = this.tokenStart;
    let name50;
    let nameLowerCase;
    let prelude = null;
    let block = null;
    this.eat(AtKeyword);
    name50 = this.substrToCursor(start + 1);
    nameLowerCase = name50.toLowerCase();
    this.skipSC();
    if (this.eof === false && this.tokenType !== LeftCurlyBracket && this.tokenType !== Semicolon) {
      if (this.parseAtrulePrelude) {
        prelude = this.parseWithFallback(this.AtrulePrelude.bind(this, name50, isDeclaration), consumeRaw);
      } else {
        prelude = consumeRaw.call(this, this.tokenIndex);
      }
      this.skipSC();
    }
    switch (this.tokenType) {
      case Semicolon:
        this.next();
        break;
      case LeftCurlyBracket:
        if (hasOwnProperty.call(this.atrule, nameLowerCase) && typeof this.atrule[nameLowerCase].block === "function") {
          block = this.atrule[nameLowerCase].block.call(this, isDeclaration);
        } else {
          block = this.Block(isDeclarationBlockAtrule.call(this));
        }
        break;
    }
    return {
      type: "Atrule",
      loc: this.getLocation(start, this.tokenStart),
      name: name50,
      prelude,
      block
    };
  }
  __name(parse5, "parse");
  function generate3(node) {
    this.token(AtKeyword, "@" + node.name);
    if (node.prelude !== null) {
      this.node(node.prelude);
    }
    if (node.block) {
      this.node(node.block);
    } else {
      this.token(Semicolon, ";");
    }
  }
  __name(generate3, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/AtrulePrelude.js
  var AtrulePrelude_exports = {};
  __export(AtrulePrelude_exports, {
    generate: () => generate4,
    name: () => name3,
    parse: () => parse6,
    structure: () => structure3,
    walkContext: () => walkContext2
  });
  var name3 = "AtrulePrelude";
  var walkContext2 = "atrulePrelude";
  var structure3 = {
    children: [[]]
  };
  function parse6(name50) {
    let children = null;
    if (name50 !== null) {
      name50 = name50.toLowerCase();
    }
    this.skipSC();
    if (hasOwnProperty.call(this.atrule, name50) && typeof this.atrule[name50].prelude === "function") {
      children = this.atrule[name50].prelude.call(this);
    } else {
      children = this.readSequence(this.scope.AtrulePrelude);
    }
    this.skipSC();
    if (this.eof !== true && this.tokenType !== LeftCurlyBracket && this.tokenType !== Semicolon) {
      this.error("Semicolon or block is expected");
    }
    return {
      type: "AtrulePrelude",
      loc: this.getLocationFromList(children),
      children
    };
  }
  __name(parse6, "parse");
  function generate4(node) {
    this.children(node);
  }
  __name(generate4, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/AttributeSelector.js
  var AttributeSelector_exports = {};
  __export(AttributeSelector_exports, {
    generate: () => generate5,
    name: () => name4,
    parse: () => parse7,
    structure: () => structure4
  });
  var DOLLARSIGN = 36;
  var ASTERISK3 = 42;
  var EQUALSSIGN = 61;
  var CIRCUMFLEXACCENT = 94;
  var VERTICALLINE2 = 124;
  var TILDE2 = 126;
  function getAttributeName() {
    if (this.eof) {
      this.error("Unexpected end of input");
    }
    const start = this.tokenStart;
    let expectIdent = false;
    if (this.isDelim(ASTERISK3)) {
      expectIdent = true;
      this.next();
    } else if (!this.isDelim(VERTICALLINE2)) {
      this.eat(Ident);
    }
    if (this.isDelim(VERTICALLINE2)) {
      if (this.charCodeAt(this.tokenStart + 1) !== EQUALSSIGN) {
        this.next();
        this.eat(Ident);
      } else if (expectIdent) {
        this.error("Identifier is expected", this.tokenEnd);
      }
    } else if (expectIdent) {
      this.error("Vertical line is expected");
    }
    return {
      type: "Identifier",
      loc: this.getLocation(start, this.tokenStart),
      name: this.substrToCursor(start)
    };
  }
  __name(getAttributeName, "getAttributeName");
  function getOperator() {
    const start = this.tokenStart;
    const code2 = this.charCodeAt(start);
    if (code2 !== EQUALSSIGN && // =
    code2 !== TILDE2 && // ~=
    code2 !== CIRCUMFLEXACCENT && // ^=
    code2 !== DOLLARSIGN && // $=
    code2 !== ASTERISK3 && // *=
    code2 !== VERTICALLINE2) {
      this.error("Attribute selector (=, ~=, ^=, $=, *=, |=) is expected");
    }
    this.next();
    if (code2 !== EQUALSSIGN) {
      if (!this.isDelim(EQUALSSIGN)) {
        this.error("Equal sign is expected");
      }
      this.next();
    }
    return this.substrToCursor(start);
  }
  __name(getOperator, "getOperator");
  var name4 = "AttributeSelector";
  var structure4 = {
    name: "Identifier",
    matcher: [String, null],
    value: ["String", "Identifier", null],
    flags: [String, null]
  };
  function parse7() {
    const start = this.tokenStart;
    let name50;
    let matcher = null;
    let value = null;
    let flags = null;
    this.eat(LeftSquareBracket);
    this.skipSC();
    name50 = getAttributeName.call(this);
    this.skipSC();
    if (this.tokenType !== RightSquareBracket) {
      if (this.tokenType !== Ident) {
        matcher = getOperator.call(this);
        this.skipSC();
        value = this.tokenType === String2 ? this.String() : this.Identifier();
        this.skipSC();
      }
      if (this.tokenType === Ident) {
        flags = this.consume(Ident);
        this.skipSC();
      }
    }
    if (!this.eof) {
      this.eat(RightSquareBracket);
    }
    return {
      type: "AttributeSelector",
      loc: this.getLocation(start, this.tokenStart),
      name: name50,
      matcher,
      value,
      flags
    };
  }
  __name(parse7, "parse");
  function generate5(node) {
    this.token(Delim, "[");
    this.node(node.name);
    if (node.matcher !== null) {
      this.tokenize(node.matcher);
      this.node(node.value);
    }
    if (node.flags !== null) {
      this.token(Ident, node.flags);
    }
    this.token(Delim, "]");
  }
  __name(generate5, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Block.js
  var Block_exports = {};
  __export(Block_exports, {
    generate: () => generate6,
    name: () => name5,
    parse: () => parse8,
    structure: () => structure5,
    walkContext: () => walkContext3
  });
  var AMPERSAND2 = 38;
  function consumeRaw2() {
    return this.Raw(null, true);
  }
  __name(consumeRaw2, "consumeRaw");
  function consumeRule() {
    return this.parseWithFallback(this.Rule, consumeRaw2);
  }
  __name(consumeRule, "consumeRule");
  function consumeRawDeclaration() {
    return this.Raw(this.consumeUntilSemicolonIncluded, true);
  }
  __name(consumeRawDeclaration, "consumeRawDeclaration");
  function consumeDeclaration() {
    if (this.tokenType === Semicolon) {
      return consumeRawDeclaration.call(this, this.tokenIndex);
    }
    const node = this.parseWithFallback(this.Declaration, consumeRawDeclaration);
    if (this.tokenType === Semicolon) {
      this.next();
    }
    return node;
  }
  __name(consumeDeclaration, "consumeDeclaration");
  var name5 = "Block";
  var walkContext3 = "block";
  var structure5 = {
    children: [[
      "Atrule",
      "Rule",
      "Declaration"
    ]]
  };
  function parse8(isStyleBlock) {
    const consumer = isStyleBlock ? consumeDeclaration : consumeRule;
    const start = this.tokenStart;
    let children = this.createList();
    this.eat(LeftCurlyBracket);
    scan:
      while (!this.eof) {
        switch (this.tokenType) {
          case RightCurlyBracket:
            break scan;
          case WhiteSpace:
          case Comment2:
            this.next();
            break;
          case AtKeyword:
            children.push(this.parseWithFallback(this.Atrule.bind(this, isStyleBlock), consumeRaw2));
            break;
          default:
            if (isStyleBlock && this.isDelim(AMPERSAND2)) {
              children.push(consumeRule.call(this));
            } else {
              children.push(consumer.call(this));
            }
        }
      }
    if (!this.eof) {
      this.eat(RightCurlyBracket);
    }
    return {
      type: "Block",
      loc: this.getLocation(start, this.tokenStart),
      children
    };
  }
  __name(parse8, "parse");
  function generate6(node) {
    this.token(LeftCurlyBracket, "{");
    this.children(node, (prev) => {
      if (prev.type === "Declaration") {
        this.token(Semicolon, ";");
      }
    });
    this.token(RightCurlyBracket, "}");
  }
  __name(generate6, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Brackets.js
  var Brackets_exports = {};
  __export(Brackets_exports, {
    generate: () => generate7,
    name: () => name6,
    parse: () => parse9,
    structure: () => structure6
  });
  var name6 = "Brackets";
  var structure6 = {
    children: [[]]
  };
  function parse9(readSequence2, recognizer) {
    const start = this.tokenStart;
    let children = null;
    this.eat(LeftSquareBracket);
    children = readSequence2.call(this, recognizer);
    if (!this.eof) {
      this.eat(RightSquareBracket);
    }
    return {
      type: "Brackets",
      loc: this.getLocation(start, this.tokenStart),
      children
    };
  }
  __name(parse9, "parse");
  function generate7(node) {
    this.token(Delim, "[");
    this.children(node);
    this.token(Delim, "]");
  }
  __name(generate7, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/CDC.js
  var CDC_exports = {};
  __export(CDC_exports, {
    generate: () => generate8,
    name: () => name7,
    parse: () => parse10,
    structure: () => structure7
  });
  var name7 = "CDC";
  var structure7 = [];
  function parse10() {
    const start = this.tokenStart;
    this.eat(CDC);
    return {
      type: "CDC",
      loc: this.getLocation(start, this.tokenStart)
    };
  }
  __name(parse10, "parse");
  function generate8() {
    this.token(CDC, "-->");
  }
  __name(generate8, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/CDO.js
  var CDO_exports = {};
  __export(CDO_exports, {
    generate: () => generate9,
    name: () => name8,
    parse: () => parse11,
    structure: () => structure8
  });
  var name8 = "CDO";
  var structure8 = [];
  function parse11() {
    const start = this.tokenStart;
    this.eat(CDO);
    return {
      type: "CDO",
      loc: this.getLocation(start, this.tokenStart)
    };
  }
  __name(parse11, "parse");
  function generate9() {
    this.token(CDO, "<!--");
  }
  __name(generate9, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/ClassSelector.js
  var ClassSelector_exports = {};
  __export(ClassSelector_exports, {
    generate: () => generate10,
    name: () => name9,
    parse: () => parse12,
    structure: () => structure9
  });
  var FULLSTOP2 = 46;
  var name9 = "ClassSelector";
  var structure9 = {
    name: String
  };
  function parse12() {
    this.eatDelim(FULLSTOP2);
    return {
      type: "ClassSelector",
      loc: this.getLocation(this.tokenStart - 1, this.tokenEnd),
      name: this.consume(Ident)
    };
  }
  __name(parse12, "parse");
  function generate10(node) {
    this.token(Delim, ".");
    this.token(Ident, node.name);
  }
  __name(generate10, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Combinator.js
  var Combinator_exports = {};
  __export(Combinator_exports, {
    generate: () => generate11,
    name: () => name10,
    parse: () => parse13,
    structure: () => structure10
  });
  var PLUSSIGN4 = 43;
  var SOLIDUS3 = 47;
  var GREATERTHANSIGN2 = 62;
  var TILDE3 = 126;
  var name10 = "Combinator";
  var structure10 = {
    name: String
  };
  function parse13() {
    const start = this.tokenStart;
    let name50;
    switch (this.tokenType) {
      case WhiteSpace:
        name50 = " ";
        break;
      case Delim:
        switch (this.charCodeAt(this.tokenStart)) {
          case GREATERTHANSIGN2:
          case PLUSSIGN4:
          case TILDE3:
            this.next();
            break;
          case SOLIDUS3:
            this.next();
            this.eatIdent("deep");
            this.eatDelim(SOLIDUS3);
            break;
          default:
            this.error("Combinator is expected");
        }
        name50 = this.substrToCursor(start);
        break;
    }
    return {
      type: "Combinator",
      loc: this.getLocation(start, this.tokenStart),
      name: name50
    };
  }
  __name(parse13, "parse");
  function generate11(node) {
    this.tokenize(node.name);
  }
  __name(generate11, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Comment.js
  var Comment_exports = {};
  __export(Comment_exports, {
    generate: () => generate12,
    name: () => name11,
    parse: () => parse14,
    structure: () => structure11
  });
  var ASTERISK4 = 42;
  var SOLIDUS4 = 47;
  var name11 = "Comment";
  var structure11 = {
    value: String
  };
  function parse14() {
    const start = this.tokenStart;
    let end = this.tokenEnd;
    this.eat(Comment2);
    if (end - start + 2 >= 2 && this.charCodeAt(end - 2) === ASTERISK4 && this.charCodeAt(end - 1) === SOLIDUS4) {
      end -= 2;
    }
    return {
      type: "Comment",
      loc: this.getLocation(start, this.tokenStart),
      value: this.substring(start + 2, end)
    };
  }
  __name(parse14, "parse");
  function generate12(node) {
    this.token(Comment2, "/*" + node.value + "*/");
  }
  __name(generate12, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Condition.js
  var Condition_exports = {};
  __export(Condition_exports, {
    generate: () => generate13,
    name: () => name12,
    parse: () => parse15,
    structure: () => structure12
  });
  var likelyFeatureToken = /* @__PURE__ */ new Set([Colon, RightParenthesis, EOF]);
  var name12 = "Condition";
  var structure12 = {
    kind: String,
    children: [[
      "Identifier",
      "Feature",
      "FeatureFunction",
      "FeatureRange",
      "SupportsDeclaration"
    ]]
  };
  function featureOrRange(kind) {
    if (this.lookupTypeNonSC(1) === Ident && likelyFeatureToken.has(this.lookupTypeNonSC(2))) {
      return this.Feature(kind);
    }
    return this.FeatureRange(kind);
  }
  __name(featureOrRange, "featureOrRange");
  var parentheses = {
    media: featureOrRange,
    container: featureOrRange,
    supports() {
      return this.SupportsDeclaration();
    }
  };
  function parse15(kind = "media") {
    const children = this.createList();
    scan: while (!this.eof) {
      switch (this.tokenType) {
        case Comment2:
        case WhiteSpace:
          this.next();
          continue;
        case Ident:
          children.push(this.Identifier());
          break;
        case LeftParenthesis: {
          let term = this.parseWithFallback(
            () => parentheses[kind].call(this, kind),
            () => null
          );
          if (!term) {
            term = this.parseWithFallback(
              () => {
                this.eat(LeftParenthesis);
                const res = this.Condition(kind);
                this.eat(RightParenthesis);
                return res;
              },
              () => {
                return this.GeneralEnclosed(kind);
              }
            );
          }
          children.push(term);
          break;
        }
        case Function: {
          let term = this.parseWithFallback(
            () => this.FeatureFunction(kind),
            () => null
          );
          if (!term) {
            term = this.GeneralEnclosed(kind);
          }
          children.push(term);
          break;
        }
        default:
          break scan;
      }
    }
    if (children.isEmpty) {
      this.error("Condition is expected");
    }
    return {
      type: "Condition",
      loc: this.getLocationFromList(children),
      kind,
      children
    };
  }
  __name(parse15, "parse");
  function generate13(node) {
    node.children.forEach((child) => {
      if (child.type === "Condition") {
        this.token(LeftParenthesis, "(");
        this.node(child);
        this.token(RightParenthesis, ")");
      } else {
        this.node(child);
      }
    });
  }
  __name(generate13, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Declaration.js
  var Declaration_exports = {};
  __export(Declaration_exports, {
    generate: () => generate14,
    name: () => name13,
    parse: () => parse16,
    structure: () => structure13,
    walkContext: () => walkContext4
  });

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/utils/names.js
  var HYPHENMINUS3 = 45;
  function isCustomProperty(str, offset) {
    offset = offset || 0;
    return str.length - offset >= 2 && str.charCodeAt(offset) === HYPHENMINUS3 && str.charCodeAt(offset + 1) === HYPHENMINUS3;
  }
  __name(isCustomProperty, "isCustomProperty");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Declaration.js
  var EXCLAMATIONMARK2 = 33;
  var NUMBERSIGN4 = 35;
  var DOLLARSIGN2 = 36;
  var AMPERSAND3 = 38;
  var ASTERISK5 = 42;
  var PLUSSIGN5 = 43;
  var SOLIDUS5 = 47;
  function consumeValueRaw() {
    return this.Raw(this.consumeUntilExclamationMarkOrSemicolon, true);
  }
  __name(consumeValueRaw, "consumeValueRaw");
  function consumeCustomPropertyRaw() {
    return this.Raw(this.consumeUntilExclamationMarkOrSemicolon, false);
  }
  __name(consumeCustomPropertyRaw, "consumeCustomPropertyRaw");
  function consumeValue() {
    const startValueToken = this.tokenIndex;
    const value = this.Value();
    if (value.type !== "Raw" && this.eof === false && this.tokenType !== Semicolon && this.isDelim(EXCLAMATIONMARK2) === false && this.isBalanceEdge(startValueToken) === false) {
      this.error();
    }
    return value;
  }
  __name(consumeValue, "consumeValue");
  var name13 = "Declaration";
  var walkContext4 = "declaration";
  var structure13 = {
    important: [Boolean, String],
    property: String,
    value: ["Value", "Raw"]
  };
  function parse16() {
    const start = this.tokenStart;
    const startToken = this.tokenIndex;
    const property = readProperty.call(this);
    const customProperty = isCustomProperty(property);
    const parseValue = customProperty ? this.parseCustomProperty : this.parseValue;
    const consumeRaw6 = customProperty ? consumeCustomPropertyRaw : consumeValueRaw;
    let important = false;
    let value;
    this.skipSC();
    this.eat(Colon);
    const valueStart = this.tokenIndex;
    if (!customProperty) {
      this.skipSC();
    }
    if (parseValue) {
      value = this.parseWithFallback(consumeValue, consumeRaw6);
    } else {
      value = consumeRaw6.call(this, this.tokenIndex);
    }
    if (customProperty && value.type === "Value" && value.children.isEmpty) {
      for (let offset = valueStart - this.tokenIndex; offset <= 0; offset++) {
        if (this.lookupType(offset) === WhiteSpace) {
          value.children.appendData({
            type: "WhiteSpace",
            loc: null,
            value: " "
          });
          break;
        }
      }
    }
    if (this.isDelim(EXCLAMATIONMARK2)) {
      important = getImportant.call(this);
      this.skipSC();
    }
    if (this.eof === false && this.tokenType !== Semicolon && this.isBalanceEdge(startToken) === false) {
      this.error();
    }
    return {
      type: "Declaration",
      loc: this.getLocation(start, this.tokenStart),
      important,
      property,
      value
    };
  }
  __name(parse16, "parse");
  function generate14(node) {
    this.token(Ident, node.property);
    this.token(Colon, ":");
    this.node(node.value);
    if (node.important) {
      this.token(Delim, "!");
      this.token(Ident, node.important === true ? "important" : node.important);
    }
  }
  __name(generate14, "generate");
  function readProperty() {
    const start = this.tokenStart;
    if (this.tokenType === Delim) {
      switch (this.charCodeAt(this.tokenStart)) {
        case ASTERISK5:
        case DOLLARSIGN2:
        case PLUSSIGN5:
        case NUMBERSIGN4:
        case AMPERSAND3:
          this.next();
          break;
        // TODO: not sure we should support this hack
        case SOLIDUS5:
          this.next();
          if (this.isDelim(SOLIDUS5)) {
            this.next();
          }
          break;
      }
    }
    if (this.tokenType === Hash) {
      this.eat(Hash);
    } else {
      this.eat(Ident);
    }
    return this.substrToCursor(start);
  }
  __name(readProperty, "readProperty");
  function getImportant() {
    this.eat(Delim);
    this.skipSC();
    const important = this.consume(Ident);
    return important === "important" ? true : important;
  }
  __name(getImportant, "getImportant");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/DeclarationList.js
  var DeclarationList_exports = {};
  __export(DeclarationList_exports, {
    generate: () => generate15,
    name: () => name14,
    parse: () => parse17,
    structure: () => structure14
  });
  var AMPERSAND4 = 38;
  function consumeRaw3() {
    return this.Raw(this.consumeUntilSemicolonIncluded, true);
  }
  __name(consumeRaw3, "consumeRaw");
  var name14 = "DeclarationList";
  var structure14 = {
    children: [[
      "Declaration",
      "Atrule",
      "Rule"
    ]]
  };
  function parse17() {
    const children = this.createList();
    scan:
      while (!this.eof) {
        switch (this.tokenType) {
          case WhiteSpace:
          case Comment2:
          case Semicolon:
            this.next();
            break;
          case AtKeyword:
            children.push(this.parseWithFallback(this.Atrule.bind(this, true), consumeRaw3));
            break;
          default:
            if (this.isDelim(AMPERSAND4)) {
              children.push(this.parseWithFallback(this.Rule, consumeRaw3));
            } else {
              children.push(this.parseWithFallback(this.Declaration, consumeRaw3));
            }
        }
      }
    return {
      type: "DeclarationList",
      loc: this.getLocationFromList(children),
      children
    };
  }
  __name(parse17, "parse");
  function generate15(node) {
    this.children(node, (prev) => {
      if (prev.type === "Declaration") {
        this.token(Semicolon, ";");
      }
    });
  }
  __name(generate15, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Dimension.js
  var Dimension_exports = {};
  __export(Dimension_exports, {
    generate: () => generate16,
    name: () => name15,
    parse: () => parse18,
    structure: () => structure15
  });
  var name15 = "Dimension";
  var structure15 = {
    value: String,
    unit: String
  };
  function parse18() {
    const start = this.tokenStart;
    const value = this.consumeNumber(Dimension);
    return {
      type: "Dimension",
      loc: this.getLocation(start, this.tokenStart),
      value,
      unit: this.substring(start + value.length, this.tokenStart)
    };
  }
  __name(parse18, "parse");
  function generate16(node) {
    this.token(Dimension, node.value + node.unit);
  }
  __name(generate16, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Feature.js
  var Feature_exports = {};
  __export(Feature_exports, {
    generate: () => generate17,
    name: () => name16,
    parse: () => parse19,
    structure: () => structure16
  });
  var SOLIDUS6 = 47;
  var name16 = "Feature";
  var structure16 = {
    kind: String,
    name: String,
    value: ["Identifier", "Number", "Dimension", "Ratio", "Function", null]
  };
  function parse19(kind) {
    const start = this.tokenStart;
    let name50;
    let value = null;
    this.eat(LeftParenthesis);
    this.skipSC();
    name50 = this.consume(Ident);
    this.skipSC();
    if (this.tokenType !== RightParenthesis) {
      this.eat(Colon);
      this.skipSC();
      switch (this.tokenType) {
        case Number2:
          if (this.lookupNonWSType(1) === Delim) {
            value = this.Ratio();
          } else {
            value = this.Number();
          }
          break;
        case Dimension:
          value = this.Dimension();
          break;
        case Ident:
          value = this.Identifier();
          break;
        case Function:
          value = this.parseWithFallback(
            () => {
              const res = this.Function(this.readSequence, this.scope.Value);
              this.skipSC();
              if (this.isDelim(SOLIDUS6)) {
                this.error();
              }
              return res;
            },
            () => {
              return this.Ratio();
            }
          );
          break;
        default:
          this.error("Number, dimension, ratio or identifier is expected");
      }
      this.skipSC();
    }
    if (!this.eof) {
      this.eat(RightParenthesis);
    }
    return {
      type: "Feature",
      loc: this.getLocation(start, this.tokenStart),
      kind,
      name: name50,
      value
    };
  }
  __name(parse19, "parse");
  function generate17(node) {
    this.token(LeftParenthesis, "(");
    this.token(Ident, node.name);
    if (node.value !== null) {
      this.token(Colon, ":");
      this.node(node.value);
    }
    this.token(RightParenthesis, ")");
  }
  __name(generate17, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/FeatureFunction.js
  var FeatureFunction_exports = {};
  __export(FeatureFunction_exports, {
    generate: () => generate18,
    name: () => name17,
    parse: () => parse20,
    structure: () => structure17
  });
  var name17 = "FeatureFunction";
  var structure17 = {
    kind: String,
    feature: String,
    value: ["Declaration", "Selector"]
  };
  function getFeatureParser(kind, name50) {
    const featuresOfKind = this.features[kind] || {};
    const parser = featuresOfKind[name50];
    if (typeof parser !== "function") {
      this.error(`Unknown feature ${name50}()`);
    }
    return parser;
  }
  __name(getFeatureParser, "getFeatureParser");
  function parse20(kind = "unknown") {
    const start = this.tokenStart;
    const functionName = this.consumeFunctionName();
    const valueParser = getFeatureParser.call(this, kind, functionName.toLowerCase());
    this.skipSC();
    const value = this.parseWithFallback(
      () => {
        const startValueToken = this.tokenIndex;
        const value2 = valueParser.call(this);
        if (this.eof === false && this.isBalanceEdge(startValueToken) === false) {
          this.error();
        }
        return value2;
      },
      () => this.Raw(null, false)
    );
    if (!this.eof) {
      this.eat(RightParenthesis);
    }
    return {
      type: "FeatureFunction",
      loc: this.getLocation(start, this.tokenStart),
      kind,
      feature: functionName,
      value
    };
  }
  __name(parse20, "parse");
  function generate18(node) {
    this.token(Function, node.feature + "(");
    this.node(node.value);
    this.token(RightParenthesis, ")");
  }
  __name(generate18, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/FeatureRange.js
  var FeatureRange_exports = {};
  __export(FeatureRange_exports, {
    generate: () => generate19,
    name: () => name18,
    parse: () => parse21,
    structure: () => structure18
  });
  var SOLIDUS7 = 47;
  var LESSTHANSIGN = 60;
  var EQUALSSIGN2 = 61;
  var GREATERTHANSIGN3 = 62;
  var name18 = "FeatureRange";
  var structure18 = {
    kind: String,
    left: ["Identifier", "Number", "Dimension", "Ratio", "Function"],
    leftComparison: String,
    middle: ["Identifier", "Number", "Dimension", "Ratio", "Function"],
    rightComparison: [String, null],
    right: ["Identifier", "Number", "Dimension", "Ratio", "Function", null]
  };
  function readTerm() {
    this.skipSC();
    switch (this.tokenType) {
      case Number2:
        if (this.isDelim(SOLIDUS7, this.lookupOffsetNonSC(1))) {
          return this.Ratio();
        } else {
          return this.Number();
        }
      case Dimension:
        return this.Dimension();
      case Ident:
        return this.Identifier();
      case Function:
        return this.parseWithFallback(
          () => {
            const res = this.Function(this.readSequence, this.scope.Value);
            this.skipSC();
            if (this.isDelim(SOLIDUS7)) {
              this.error();
            }
            return res;
          },
          () => {
            return this.Ratio();
          }
        );
      default:
        this.error("Number, dimension, ratio or identifier is expected");
    }
  }
  __name(readTerm, "readTerm");
  function readComparison(expectColon) {
    this.skipSC();
    if (this.isDelim(LESSTHANSIGN) || this.isDelim(GREATERTHANSIGN3)) {
      const value = this.source[this.tokenStart];
      this.next();
      if (this.isDelim(EQUALSSIGN2)) {
        this.next();
        return value + "=";
      }
      return value;
    }
    if (this.isDelim(EQUALSSIGN2)) {
      return "=";
    }
    this.error(`Expected ${expectColon ? '":", ' : ""}"<", ">", "=" or ")"`);
  }
  __name(readComparison, "readComparison");
  function parse21(kind = "unknown") {
    const start = this.tokenStart;
    this.skipSC();
    this.eat(LeftParenthesis);
    const left = readTerm.call(this);
    const leftComparison = readComparison.call(this, left.type === "Identifier");
    const middle = readTerm.call(this);
    let rightComparison = null;
    let right = null;
    if (this.lookupNonWSType(0) !== RightParenthesis) {
      rightComparison = readComparison.call(this);
      right = readTerm.call(this);
    }
    this.skipSC();
    this.eat(RightParenthesis);
    return {
      type: "FeatureRange",
      loc: this.getLocation(start, this.tokenStart),
      kind,
      left,
      leftComparison,
      middle,
      rightComparison,
      right
    };
  }
  __name(parse21, "parse");
  function generate19(node) {
    this.token(LeftParenthesis, "(");
    this.node(node.left);
    this.tokenize(node.leftComparison);
    this.node(node.middle);
    if (node.right) {
      this.tokenize(node.rightComparison);
      this.node(node.right);
    }
    this.token(RightParenthesis, ")");
  }
  __name(generate19, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Function.js
  var Function_exports = {};
  __export(Function_exports, {
    generate: () => generate20,
    name: () => name19,
    parse: () => parse22,
    structure: () => structure19,
    walkContext: () => walkContext5
  });
  var name19 = "Function";
  var walkContext5 = "function";
  var structure19 = {
    name: String,
    children: [[]]
  };
  function parse22(readSequence2, recognizer) {
    const start = this.tokenStart;
    const name50 = this.consumeFunctionName();
    const nameLowerCase = name50.toLowerCase();
    let children;
    children = recognizer.hasOwnProperty(nameLowerCase) ? recognizer[nameLowerCase].call(this, recognizer) : readSequence2.call(this, recognizer);
    if (!this.eof) {
      this.eat(RightParenthesis);
    }
    return {
      type: "Function",
      loc: this.getLocation(start, this.tokenStart),
      name: name50,
      children
    };
  }
  __name(parse22, "parse");
  function generate20(node) {
    this.token(Function, node.name + "(");
    this.children(node);
    this.token(RightParenthesis, ")");
  }
  __name(generate20, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/GeneralEnclosed.js
  var GeneralEnclosed_exports = {};
  __export(GeneralEnclosed_exports, {
    generate: () => generate21,
    name: () => name20,
    parse: () => parse23,
    structure: () => structure20
  });
  var name20 = "GeneralEnclosed";
  var structure20 = {
    kind: String,
    function: [String, null],
    children: [[]]
  };
  function parse23(kind) {
    const start = this.tokenStart;
    let functionName = null;
    if (this.tokenType === Function) {
      functionName = this.consumeFunctionName();
    } else {
      this.eat(LeftParenthesis);
    }
    const children = this.parseWithFallback(
      () => {
        const startValueToken = this.tokenIndex;
        const children2 = this.readSequence(this.scope.Value);
        if (this.eof === false && this.isBalanceEdge(startValueToken) === false) {
          this.error();
        }
        return children2;
      },
      () => this.createSingleNodeList(
        this.Raw(null, false)
      )
    );
    if (!this.eof) {
      this.eat(RightParenthesis);
    }
    return {
      type: "GeneralEnclosed",
      loc: this.getLocation(start, this.tokenStart),
      kind,
      function: functionName,
      children
    };
  }
  __name(parse23, "parse");
  function generate21(node) {
    if (node.function) {
      this.token(Function, node.function + "(");
    } else {
      this.token(LeftParenthesis, "(");
    }
    this.children(node);
    this.token(RightParenthesis, ")");
  }
  __name(generate21, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Hash.js
  var Hash_exports = {};
  __export(Hash_exports, {
    generate: () => generate22,
    name: () => name21,
    parse: () => parse24,
    structure: () => structure21,
    xxx: () => xxx
  });
  var xxx = "XXX";
  var name21 = "Hash";
  var structure21 = {
    value: String
  };
  function parse24() {
    const start = this.tokenStart;
    this.eat(Hash);
    return {
      type: "Hash",
      loc: this.getLocation(start, this.tokenStart),
      value: this.substrToCursor(start + 1)
    };
  }
  __name(parse24, "parse");
  function generate22(node) {
    this.token(Hash, "#" + node.value);
  }
  __name(generate22, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Identifier.js
  var Identifier_exports = {};
  __export(Identifier_exports, {
    generate: () => generate23,
    name: () => name22,
    parse: () => parse25,
    structure: () => structure22
  });
  var name22 = "Identifier";
  var structure22 = {
    name: String
  };
  function parse25() {
    return {
      type: "Identifier",
      loc: this.getLocation(this.tokenStart, this.tokenEnd),
      name: this.consume(Ident)
    };
  }
  __name(parse25, "parse");
  function generate23(node) {
    this.token(Ident, node.name);
  }
  __name(generate23, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/IdSelector.js
  var IdSelector_exports = {};
  __export(IdSelector_exports, {
    generate: () => generate24,
    name: () => name23,
    parse: () => parse26,
    structure: () => structure23
  });
  var name23 = "IdSelector";
  var structure23 = {
    name: String
  };
  function parse26() {
    const start = this.tokenStart;
    this.eat(Hash);
    return {
      type: "IdSelector",
      loc: this.getLocation(start, this.tokenStart),
      name: this.substrToCursor(start + 1)
    };
  }
  __name(parse26, "parse");
  function generate24(node) {
    this.token(Delim, "#" + node.name);
  }
  __name(generate24, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Layer.js
  var Layer_exports = {};
  __export(Layer_exports, {
    generate: () => generate25,
    name: () => name24,
    parse: () => parse27,
    structure: () => structure24
  });
  var FULLSTOP3 = 46;
  var name24 = "Layer";
  var structure24 = {
    name: String
  };
  function parse27() {
    let tokenStart = this.tokenStart;
    let name50 = this.consume(Ident);
    while (this.isDelim(FULLSTOP3)) {
      this.eat(Delim);
      name50 += "." + this.consume(Ident);
    }
    return {
      type: "Layer",
      loc: this.getLocation(tokenStart, this.tokenStart),
      name: name50
    };
  }
  __name(parse27, "parse");
  function generate25(node) {
    this.tokenize(node.name);
  }
  __name(generate25, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/LayerList.js
  var LayerList_exports = {};
  __export(LayerList_exports, {
    generate: () => generate26,
    name: () => name25,
    parse: () => parse28,
    structure: () => structure25
  });
  var name25 = "LayerList";
  var structure25 = {
    children: [[
      "Layer"
    ]]
  };
  function parse28() {
    const children = this.createList();
    this.skipSC();
    while (!this.eof) {
      children.push(this.Layer());
      if (this.lookupTypeNonSC(0) !== Comma) {
        break;
      }
      this.skipSC();
      this.next();
      this.skipSC();
    }
    return {
      type: "LayerList",
      loc: this.getLocationFromList(children),
      children
    };
  }
  __name(parse28, "parse");
  function generate26(node) {
    this.children(node, () => this.token(Comma, ","));
  }
  __name(generate26, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/MediaQuery.js
  var MediaQuery_exports = {};
  __export(MediaQuery_exports, {
    generate: () => generate27,
    name: () => name26,
    parse: () => parse29,
    structure: () => structure26
  });
  var name26 = "MediaQuery";
  var structure26 = {
    modifier: [String, null],
    mediaType: [String, null],
    condition: ["Condition", null]
  };
  function parse29() {
    const start = this.tokenStart;
    let modifier = null;
    let mediaType = null;
    let condition = null;
    this.skipSC();
    if (this.tokenType === Ident && this.lookupTypeNonSC(1) !== LeftParenthesis) {
      const ident = this.consume(Ident);
      const identLowerCase = ident.toLowerCase();
      if (identLowerCase === "not" || identLowerCase === "only") {
        this.skipSC();
        modifier = identLowerCase;
        mediaType = this.consume(Ident);
      } else {
        mediaType = ident;
      }
      switch (this.lookupTypeNonSC(0)) {
        case Ident: {
          this.skipSC();
          this.eatIdent("and");
          condition = this.Condition("media");
          break;
        }
        case LeftCurlyBracket:
        case Semicolon:
        case Comma:
        case EOF:
          break;
        default:
          this.error("Identifier or parenthesis is expected");
      }
    } else {
      switch (this.tokenType) {
        case Ident:
        case LeftParenthesis:
        case Function: {
          condition = this.Condition("media");
          break;
        }
        case LeftCurlyBracket:
        case Semicolon:
        case EOF:
          break;
        default:
          this.error("Identifier or parenthesis is expected");
      }
    }
    return {
      type: "MediaQuery",
      loc: this.getLocation(start, this.tokenStart),
      modifier,
      mediaType,
      condition
    };
  }
  __name(parse29, "parse");
  function generate27(node) {
    if (node.mediaType) {
      if (node.modifier) {
        this.token(Ident, node.modifier);
      }
      this.token(Ident, node.mediaType);
      if (node.condition) {
        this.token(Ident, "and");
        this.node(node.condition);
      }
    } else if (node.condition) {
      this.node(node.condition);
    }
  }
  __name(generate27, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/MediaQueryList.js
  var MediaQueryList_exports = {};
  __export(MediaQueryList_exports, {
    generate: () => generate28,
    name: () => name27,
    parse: () => parse30,
    structure: () => structure27
  });
  var name27 = "MediaQueryList";
  var structure27 = {
    children: [[
      "MediaQuery"
    ]]
  };
  function parse30() {
    const children = this.createList();
    this.skipSC();
    while (!this.eof) {
      children.push(this.MediaQuery());
      if (this.tokenType !== Comma) {
        break;
      }
      this.next();
    }
    return {
      type: "MediaQueryList",
      loc: this.getLocationFromList(children),
      children
    };
  }
  __name(parse30, "parse");
  function generate28(node) {
    this.children(node, () => this.token(Comma, ","));
  }
  __name(generate28, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/NestingSelector.js
  var NestingSelector_exports = {};
  __export(NestingSelector_exports, {
    generate: () => generate29,
    name: () => name28,
    parse: () => parse31,
    structure: () => structure28
  });
  var AMPERSAND5 = 38;
  var name28 = "NestingSelector";
  var structure28 = {};
  function parse31() {
    const start = this.tokenStart;
    this.eatDelim(AMPERSAND5);
    return {
      type: "NestingSelector",
      loc: this.getLocation(start, this.tokenStart)
    };
  }
  __name(parse31, "parse");
  function generate29() {
    this.token(Delim, "&");
  }
  __name(generate29, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Nth.js
  var Nth_exports = {};
  __export(Nth_exports, {
    generate: () => generate30,
    name: () => name29,
    parse: () => parse32,
    structure: () => structure29
  });
  var name29 = "Nth";
  var structure29 = {
    nth: ["AnPlusB", "Identifier"],
    selector: ["SelectorList", null]
  };
  function parse32() {
    this.skipSC();
    const start = this.tokenStart;
    let end = start;
    let selector2 = null;
    let nth2;
    if (this.lookupValue(0, "odd") || this.lookupValue(0, "even")) {
      nth2 = this.Identifier();
    } else {
      nth2 = this.AnPlusB();
    }
    end = this.tokenStart;
    this.skipSC();
    if (this.lookupValue(0, "of")) {
      this.next();
      selector2 = this.SelectorList();
      end = this.tokenStart;
    }
    return {
      type: "Nth",
      loc: this.getLocation(start, end),
      nth: nth2,
      selector: selector2
    };
  }
  __name(parse32, "parse");
  function generate30(node) {
    this.node(node.nth);
    if (node.selector !== null) {
      this.token(Ident, "of");
      this.node(node.selector);
    }
  }
  __name(generate30, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Number.js
  var Number_exports = {};
  __export(Number_exports, {
    generate: () => generate31,
    name: () => name30,
    parse: () => parse33,
    structure: () => structure30
  });
  var name30 = "Number";
  var structure30 = {
    value: String
  };
  function parse33() {
    return {
      type: "Number",
      loc: this.getLocation(this.tokenStart, this.tokenEnd),
      value: this.consume(Number2)
    };
  }
  __name(parse33, "parse");
  function generate31(node) {
    this.token(Number2, node.value);
  }
  __name(generate31, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Operator.js
  var Operator_exports = {};
  __export(Operator_exports, {
    generate: () => generate32,
    name: () => name31,
    parse: () => parse34,
    structure: () => structure31
  });
  var name31 = "Operator";
  var structure31 = {
    value: String
  };
  function parse34() {
    const start = this.tokenStart;
    this.next();
    return {
      type: "Operator",
      loc: this.getLocation(start, this.tokenStart),
      value: this.substrToCursor(start)
    };
  }
  __name(parse34, "parse");
  function generate32(node) {
    this.tokenize(node.value);
  }
  __name(generate32, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Parentheses.js
  var Parentheses_exports = {};
  __export(Parentheses_exports, {
    generate: () => generate33,
    name: () => name32,
    parse: () => parse35,
    structure: () => structure32
  });
  var name32 = "Parentheses";
  var structure32 = {
    children: [[]]
  };
  function parse35(readSequence2, recognizer) {
    const start = this.tokenStart;
    let children = null;
    this.eat(LeftParenthesis);
    children = readSequence2.call(this, recognizer);
    if (!this.eof) {
      this.eat(RightParenthesis);
    }
    return {
      type: "Parentheses",
      loc: this.getLocation(start, this.tokenStart),
      children
    };
  }
  __name(parse35, "parse");
  function generate33(node) {
    this.token(LeftParenthesis, "(");
    this.children(node);
    this.token(RightParenthesis, ")");
  }
  __name(generate33, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Percentage.js
  var Percentage_exports = {};
  __export(Percentage_exports, {
    generate: () => generate34,
    name: () => name33,
    parse: () => parse36,
    structure: () => structure33
  });
  var name33 = "Percentage";
  var structure33 = {
    value: String
  };
  function parse36() {
    return {
      type: "Percentage",
      loc: this.getLocation(this.tokenStart, this.tokenEnd),
      value: this.consumeNumber(Percentage)
    };
  }
  __name(parse36, "parse");
  function generate34(node) {
    this.token(Percentage, node.value + "%");
  }
  __name(generate34, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/PseudoClassSelector.js
  var PseudoClassSelector_exports = {};
  __export(PseudoClassSelector_exports, {
    generate: () => generate35,
    name: () => name34,
    parse: () => parse37,
    structure: () => structure34,
    walkContext: () => walkContext6
  });
  var name34 = "PseudoClassSelector";
  var walkContext6 = "function";
  var structure34 = {
    name: String,
    children: [["Raw"], null]
  };
  function parse37() {
    const start = this.tokenStart;
    let children = null;
    let name50;
    let nameLowerCase;
    this.eat(Colon);
    if (this.tokenType === Function) {
      name50 = this.consumeFunctionName();
      nameLowerCase = name50.toLowerCase();
      if (this.lookupNonWSType(0) == RightParenthesis) {
        children = this.createList();
      } else if (hasOwnProperty.call(this.pseudo, nameLowerCase)) {
        this.skipSC();
        children = this.pseudo[nameLowerCase].call(this);
        this.skipSC();
      } else {
        children = this.createList();
        children.push(
          this.Raw(null, false)
        );
      }
      this.eat(RightParenthesis);
    } else {
      name50 = this.consume(Ident);
    }
    return {
      type: "PseudoClassSelector",
      loc: this.getLocation(start, this.tokenStart),
      name: name50,
      children
    };
  }
  __name(parse37, "parse");
  function generate35(node) {
    this.token(Colon, ":");
    if (node.children === null) {
      this.token(Ident, node.name);
    } else {
      this.token(Function, node.name + "(");
      this.children(node);
      this.token(RightParenthesis, ")");
    }
  }
  __name(generate35, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/PseudoElementSelector.js
  var PseudoElementSelector_exports = {};
  __export(PseudoElementSelector_exports, {
    generate: () => generate36,
    name: () => name35,
    parse: () => parse38,
    structure: () => structure35,
    walkContext: () => walkContext7
  });
  var name35 = "PseudoElementSelector";
  var walkContext7 = "function";
  var structure35 = {
    name: String,
    children: [["Raw"], null]
  };
  function parse38() {
    const start = this.tokenStart;
    let children = null;
    let name50;
    let nameLowerCase;
    this.eat(Colon);
    this.eat(Colon);
    if (this.tokenType === Function) {
      name50 = this.consumeFunctionName();
      nameLowerCase = name50.toLowerCase();
      if (this.lookupNonWSType(0) == RightParenthesis) {
        children = this.createList();
      } else if (hasOwnProperty.call(this.pseudo, nameLowerCase)) {
        this.skipSC();
        children = this.pseudo[nameLowerCase].call(this);
        this.skipSC();
      } else {
        children = this.createList();
        children.push(
          this.Raw(null, false)
        );
      }
      this.eat(RightParenthesis);
    } else {
      name50 = this.consume(Ident);
    }
    return {
      type: "PseudoElementSelector",
      loc: this.getLocation(start, this.tokenStart),
      name: name50,
      children
    };
  }
  __name(parse38, "parse");
  function generate36(node) {
    this.token(Colon, ":");
    this.token(Colon, ":");
    if (node.children === null) {
      this.token(Ident, node.name);
    } else {
      this.token(Function, node.name + "(");
      this.children(node);
      this.token(RightParenthesis, ")");
    }
  }
  __name(generate36, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Ratio.js
  var Ratio_exports = {};
  __export(Ratio_exports, {
    generate: () => generate37,
    name: () => name36,
    parse: () => parse39,
    structure: () => structure36
  });
  var SOLIDUS8 = 47;
  function consumeTerm() {
    this.skipSC();
    switch (this.tokenType) {
      case Number2:
        return this.Number();
      case Function:
        return this.Function(this.readSequence, this.scope.Value);
      default:
        this.error("Number of function is expected");
    }
  }
  __name(consumeTerm, "consumeTerm");
  var name36 = "Ratio";
  var structure36 = {
    left: ["Number", "Function"],
    right: ["Number", "Function", null]
  };
  function parse39() {
    const start = this.tokenStart;
    const left = consumeTerm.call(this);
    let right = null;
    this.skipSC();
    if (this.isDelim(SOLIDUS8)) {
      this.eatDelim(SOLIDUS8);
      right = consumeTerm.call(this);
    }
    return {
      type: "Ratio",
      loc: this.getLocation(start, this.tokenStart),
      left,
      right
    };
  }
  __name(parse39, "parse");
  function generate37(node) {
    this.node(node.left);
    this.token(Delim, "/");
    if (node.right) {
      this.node(node.right);
    } else {
      this.node(Number2, 1);
    }
  }
  __name(generate37, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Raw.js
  var Raw_exports = {};
  __export(Raw_exports, {
    generate: () => generate38,
    name: () => name37,
    parse: () => parse40,
    structure: () => structure37
  });
  function getOffsetExcludeWS() {
    if (this.tokenIndex > 0) {
      if (this.lookupType(-1) === WhiteSpace) {
        return this.tokenIndex > 1 ? this.getTokenStart(this.tokenIndex - 1) : this.firstCharOffset;
      }
    }
    return this.tokenStart;
  }
  __name(getOffsetExcludeWS, "getOffsetExcludeWS");
  var name37 = "Raw";
  var structure37 = {
    value: String
  };
  function parse40(consumeUntil, excludeWhiteSpace) {
    const startOffset = this.getTokenStart(this.tokenIndex);
    let endOffset;
    this.skipUntilBalanced(this.tokenIndex, consumeUntil || this.consumeUntilBalanceEnd);
    if (excludeWhiteSpace && this.tokenStart > startOffset) {
      endOffset = getOffsetExcludeWS.call(this);
    } else {
      endOffset = this.tokenStart;
    }
    return {
      type: "Raw",
      loc: this.getLocation(startOffset, endOffset),
      value: this.substring(startOffset, endOffset)
    };
  }
  __name(parse40, "parse");
  function generate38(node) {
    this.tokenize(node.value);
  }
  __name(generate38, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Rule.js
  var Rule_exports = {};
  __export(Rule_exports, {
    generate: () => generate39,
    name: () => name38,
    parse: () => parse41,
    structure: () => structure38,
    walkContext: () => walkContext8
  });
  function consumeRaw4() {
    return this.Raw(this.consumeUntilLeftCurlyBracket, true);
  }
  __name(consumeRaw4, "consumeRaw");
  function consumePrelude() {
    const prelude = this.SelectorList();
    if (prelude.type !== "Raw" && this.eof === false && this.tokenType !== LeftCurlyBracket) {
      this.error();
    }
    return prelude;
  }
  __name(consumePrelude, "consumePrelude");
  var name38 = "Rule";
  var walkContext8 = "rule";
  var structure38 = {
    prelude: ["SelectorList", "Raw"],
    block: ["Block"]
  };
  function parse41() {
    const startToken = this.tokenIndex;
    const startOffset = this.tokenStart;
    let prelude;
    let block;
    if (this.parseRulePrelude) {
      prelude = this.parseWithFallback(consumePrelude, consumeRaw4);
    } else {
      prelude = consumeRaw4.call(this, startToken);
    }
    block = this.Block(true);
    return {
      type: "Rule",
      loc: this.getLocation(startOffset, this.tokenStart),
      prelude,
      block
    };
  }
  __name(parse41, "parse");
  function generate39(node) {
    this.node(node.prelude);
    this.node(node.block);
  }
  __name(generate39, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Scope.js
  var Scope_exports = {};
  __export(Scope_exports, {
    generate: () => generate40,
    name: () => name39,
    parse: () => parse42,
    structure: () => structure39
  });
  var name39 = "Scope";
  var structure39 = {
    root: ["SelectorList", "Raw", null],
    limit: ["SelectorList", "Raw", null]
  };
  function parse42() {
    let root = null;
    let limit = null;
    this.skipSC();
    const startOffset = this.tokenStart;
    if (this.tokenType === LeftParenthesis) {
      this.next();
      this.skipSC();
      root = this.parseWithFallback(
        this.SelectorList,
        () => this.Raw(false, true)
      );
      this.skipSC();
      this.eat(RightParenthesis);
    }
    if (this.lookupNonWSType(0) === Ident) {
      this.skipSC();
      this.eatIdent("to");
      this.skipSC();
      this.eat(LeftParenthesis);
      this.skipSC();
      limit = this.parseWithFallback(
        this.SelectorList,
        () => this.Raw(false, true)
      );
      this.skipSC();
      this.eat(RightParenthesis);
    }
    return {
      type: "Scope",
      loc: this.getLocation(startOffset, this.tokenStart),
      root,
      limit
    };
  }
  __name(parse42, "parse");
  function generate40(node) {
    if (node.root) {
      this.token(LeftParenthesis, "(");
      this.node(node.root);
      this.token(RightParenthesis, ")");
    }
    if (node.limit) {
      this.token(Ident, "to");
      this.token(LeftParenthesis, "(");
      this.node(node.limit);
      this.token(RightParenthesis, ")");
    }
  }
  __name(generate40, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Selector.js
  var Selector_exports = {};
  __export(Selector_exports, {
    generate: () => generate41,
    name: () => name40,
    parse: () => parse43,
    structure: () => structure40
  });
  var name40 = "Selector";
  var structure40 = {
    children: [[
      "TypeSelector",
      "IdSelector",
      "ClassSelector",
      "AttributeSelector",
      "PseudoClassSelector",
      "PseudoElementSelector",
      "Combinator"
    ]]
  };
  function parse43() {
    const children = this.readSequence(this.scope.Selector);
    if (this.getFirstListNode(children) === null) {
      this.error("Selector is expected");
    }
    return {
      type: "Selector",
      loc: this.getLocationFromList(children),
      children
    };
  }
  __name(parse43, "parse");
  function generate41(node) {
    this.children(node);
  }
  __name(generate41, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/SelectorList.js
  var SelectorList_exports = {};
  __export(SelectorList_exports, {
    generate: () => generate42,
    name: () => name41,
    parse: () => parse44,
    structure: () => structure41,
    walkContext: () => walkContext9
  });
  var name41 = "SelectorList";
  var walkContext9 = "selector";
  var structure41 = {
    children: [[
      "Selector",
      "Raw"
    ]]
  };
  function parse44() {
    const children = this.createList();
    while (!this.eof) {
      children.push(this.Selector());
      if (this.tokenType === Comma) {
        this.next();
        continue;
      }
      break;
    }
    return {
      type: "SelectorList",
      loc: this.getLocationFromList(children),
      children
    };
  }
  __name(parse44, "parse");
  function generate42(node) {
    this.children(node, () => this.token(Comma, ","));
  }
  __name(generate42, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/String.js
  var String_exports = {};
  __export(String_exports, {
    generate: () => generate43,
    name: () => name42,
    parse: () => parse45,
    structure: () => structure42
  });

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/utils/string.js
  var REVERSE_SOLIDUS = 92;
  var QUOTATION_MARK = 34;
  var APOSTROPHE = 39;
  function decode(str) {
    const len = str.length;
    const firstChar = str.charCodeAt(0);
    const start = firstChar === QUOTATION_MARK || firstChar === APOSTROPHE ? 1 : 0;
    const end = start === 1 && len > 1 && str.charCodeAt(len - 1) === firstChar ? len - 2 : len - 1;
    let decoded = "";
    for (let i = start; i <= end; i++) {
      let code2 = str.charCodeAt(i);
      if (code2 === REVERSE_SOLIDUS) {
        if (i === end) {
          if (i !== len - 1) {
            decoded = str.substr(i + 1);
          }
          break;
        }
        code2 = str.charCodeAt(++i);
        if (isValidEscape(REVERSE_SOLIDUS, code2)) {
          const escapeStart = i - 1;
          const escapeEnd = consumeEscaped(str, escapeStart);
          i = escapeEnd - 1;
          decoded += decodeEscaped(str.substring(escapeStart + 1, escapeEnd));
        } else {
          if (code2 === 13 && str.charCodeAt(i + 1) === 10) {
            i++;
          }
        }
      } else {
        decoded += str[i];
      }
    }
    return decoded;
  }
  __name(decode, "decode");
  function encode(str, apostrophe) {
    const quote = apostrophe ? "'" : '"';
    const quoteCode = apostrophe ? APOSTROPHE : QUOTATION_MARK;
    let encoded = "";
    let wsBeforeHexIsNeeded = false;
    for (let i = 0; i < str.length; i++) {
      const code2 = str.charCodeAt(i);
      if (code2 === 0) {
        encoded += "\uFFFD";
        continue;
      }
      if (code2 <= 31 || code2 === 127) {
        encoded += "\\" + code2.toString(16);
        wsBeforeHexIsNeeded = true;
        continue;
      }
      if (code2 === quoteCode || code2 === REVERSE_SOLIDUS) {
        encoded += "\\" + str.charAt(i);
        wsBeforeHexIsNeeded = false;
      } else {
        if (wsBeforeHexIsNeeded && (isHexDigit(code2) || isWhiteSpace(code2))) {
          encoded += " ";
        }
        encoded += str.charAt(i);
        wsBeforeHexIsNeeded = false;
      }
    }
    return quote + encoded + quote;
  }
  __name(encode, "encode");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/String.js
  var name42 = "String";
  var structure42 = {
    value: String
  };
  function parse45() {
    return {
      type: "String",
      loc: this.getLocation(this.tokenStart, this.tokenEnd),
      value: decode(this.consume(String2))
    };
  }
  __name(parse45, "parse");
  function generate43(node) {
    this.token(String2, encode(node.value));
  }
  __name(generate43, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/StyleSheet.js
  var StyleSheet_exports = {};
  __export(StyleSheet_exports, {
    generate: () => generate44,
    name: () => name43,
    parse: () => parse46,
    structure: () => structure43,
    walkContext: () => walkContext10
  });
  var EXCLAMATIONMARK3 = 33;
  function consumeRaw5() {
    return this.Raw(null, false);
  }
  __name(consumeRaw5, "consumeRaw");
  var name43 = "StyleSheet";
  var walkContext10 = "stylesheet";
  var structure43 = {
    children: [[
      "Comment",
      "CDO",
      "CDC",
      "Atrule",
      "Rule",
      "Raw"
    ]]
  };
  function parse46() {
    const start = this.tokenStart;
    const children = this.createList();
    let child;
    scan:
      while (!this.eof) {
        switch (this.tokenType) {
          case WhiteSpace:
            this.next();
            continue;
          case Comment2:
            if (this.charCodeAt(this.tokenStart + 2) !== EXCLAMATIONMARK3) {
              this.next();
              continue;
            }
            child = this.Comment();
            break;
          case CDO:
            child = this.CDO();
            break;
          case CDC:
            child = this.CDC();
            break;
          // CSS Syntax Module Level 3
          // §2.2 Error handling
          // At the "top level" of a stylesheet, an <at-keyword-token> starts an at-rule.
          case AtKeyword:
            child = this.parseWithFallback(this.Atrule, consumeRaw5);
            break;
          // Anything else starts a qualified rule ...
          default:
            child = this.parseWithFallback(this.Rule, consumeRaw5);
        }
        children.push(child);
      }
    return {
      type: "StyleSheet",
      loc: this.getLocation(start, this.tokenStart),
      children
    };
  }
  __name(parse46, "parse");
  function generate44(node) {
    this.children(node);
  }
  __name(generate44, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/SupportsDeclaration.js
  var SupportsDeclaration_exports = {};
  __export(SupportsDeclaration_exports, {
    generate: () => generate45,
    name: () => name44,
    parse: () => parse47,
    structure: () => structure44
  });
  var name44 = "SupportsDeclaration";
  var structure44 = {
    declaration: "Declaration"
  };
  function parse47() {
    const start = this.tokenStart;
    this.eat(LeftParenthesis);
    this.skipSC();
    const declaration = this.Declaration();
    if (!this.eof) {
      this.eat(RightParenthesis);
    }
    return {
      type: "SupportsDeclaration",
      loc: this.getLocation(start, this.tokenStart),
      declaration
    };
  }
  __name(parse47, "parse");
  function generate45(node) {
    this.token(LeftParenthesis, "(");
    this.node(node.declaration);
    this.token(RightParenthesis, ")");
  }
  __name(generate45, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/TypeSelector.js
  var TypeSelector_exports = {};
  __export(TypeSelector_exports, {
    generate: () => generate46,
    name: () => name45,
    parse: () => parse48,
    structure: () => structure45
  });
  var ASTERISK6 = 42;
  var VERTICALLINE3 = 124;
  function eatIdentifierOrAsterisk() {
    if (this.tokenType !== Ident && this.isDelim(ASTERISK6) === false) {
      this.error("Identifier or asterisk is expected");
    }
    this.next();
  }
  __name(eatIdentifierOrAsterisk, "eatIdentifierOrAsterisk");
  var name45 = "TypeSelector";
  var structure45 = {
    name: String
  };
  function parse48() {
    const start = this.tokenStart;
    if (this.isDelim(VERTICALLINE3)) {
      this.next();
      eatIdentifierOrAsterisk.call(this);
    } else {
      eatIdentifierOrAsterisk.call(this);
      if (this.isDelim(VERTICALLINE3)) {
        this.next();
        eatIdentifierOrAsterisk.call(this);
      }
    }
    return {
      type: "TypeSelector",
      loc: this.getLocation(start, this.tokenStart),
      name: this.substrToCursor(start)
    };
  }
  __name(parse48, "parse");
  function generate46(node) {
    this.tokenize(node.name);
  }
  __name(generate46, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/UnicodeRange.js
  var UnicodeRange_exports = {};
  __export(UnicodeRange_exports, {
    generate: () => generate47,
    name: () => name46,
    parse: () => parse49,
    structure: () => structure46
  });
  var PLUSSIGN6 = 43;
  var HYPHENMINUS4 = 45;
  var QUESTIONMARK = 63;
  function eatHexSequence(offset, allowDash) {
    let len = 0;
    for (let pos = this.tokenStart + offset; pos < this.tokenEnd; pos++) {
      const code2 = this.charCodeAt(pos);
      if (code2 === HYPHENMINUS4 && allowDash && len !== 0) {
        eatHexSequence.call(this, offset + len + 1, false);
        return -1;
      }
      if (!isHexDigit(code2)) {
        this.error(
          allowDash && len !== 0 ? "Hyphen minus" + (len < 6 ? " or hex digit" : "") + " is expected" : len < 6 ? "Hex digit is expected" : "Unexpected input",
          pos
        );
      }
      if (++len > 6) {
        this.error("Too many hex digits", pos);
      }
      ;
    }
    this.next();
    return len;
  }
  __name(eatHexSequence, "eatHexSequence");
  function eatQuestionMarkSequence(max) {
    let count = 0;
    while (this.isDelim(QUESTIONMARK)) {
      if (++count > max) {
        this.error("Too many question marks");
      }
      this.next();
    }
  }
  __name(eatQuestionMarkSequence, "eatQuestionMarkSequence");
  function startsWith(code2) {
    if (this.charCodeAt(this.tokenStart) !== code2) {
      this.error((code2 === PLUSSIGN6 ? "Plus sign" : "Hyphen minus") + " is expected");
    }
  }
  __name(startsWith, "startsWith");
  function scanUnicodeRange() {
    let hexLength = 0;
    switch (this.tokenType) {
      case Number2:
        hexLength = eatHexSequence.call(this, 1, true);
        if (this.isDelim(QUESTIONMARK)) {
          eatQuestionMarkSequence.call(this, 6 - hexLength);
          break;
        }
        if (this.tokenType === Dimension || this.tokenType === Number2) {
          startsWith.call(this, HYPHENMINUS4);
          eatHexSequence.call(this, 1, false);
          break;
        }
        break;
      case Dimension:
        hexLength = eatHexSequence.call(this, 1, true);
        if (hexLength > 0) {
          eatQuestionMarkSequence.call(this, 6 - hexLength);
        }
        break;
      default:
        this.eatDelim(PLUSSIGN6);
        if (this.tokenType === Ident) {
          hexLength = eatHexSequence.call(this, 0, true);
          if (hexLength > 0) {
            eatQuestionMarkSequence.call(this, 6 - hexLength);
          }
          break;
        }
        if (this.isDelim(QUESTIONMARK)) {
          this.next();
          eatQuestionMarkSequence.call(this, 5);
          break;
        }
        this.error("Hex digit or question mark is expected");
    }
  }
  __name(scanUnicodeRange, "scanUnicodeRange");
  var name46 = "UnicodeRange";
  var structure46 = {
    value: String
  };
  function parse49() {
    const start = this.tokenStart;
    this.eatIdent("u");
    scanUnicodeRange.call(this);
    return {
      type: "UnicodeRange",
      loc: this.getLocation(start, this.tokenStart),
      value: this.substrToCursor(start)
    };
  }
  __name(parse49, "parse");
  function generate47(node) {
    this.tokenize(node.value);
  }
  __name(generate47, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Url.js
  var Url_exports = {};
  __export(Url_exports, {
    generate: () => generate48,
    name: () => name47,
    parse: () => parse50,
    structure: () => structure47
  });

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/utils/url.js
  var SPACE = 32;
  var REVERSE_SOLIDUS2 = 92;
  var QUOTATION_MARK2 = 34;
  var APOSTROPHE2 = 39;
  var LEFTPARENTHESIS = 40;
  var RIGHTPARENTHESIS = 41;
  function decode2(str) {
    const len = str.length;
    let start = 4;
    let end = str.charCodeAt(len - 1) === RIGHTPARENTHESIS ? len - 2 : len - 1;
    let decoded = "";
    while (start < end && isWhiteSpace(str.charCodeAt(start))) {
      start++;
    }
    while (start < end && isWhiteSpace(str.charCodeAt(end))) {
      end--;
    }
    for (let i = start; i <= end; i++) {
      let code2 = str.charCodeAt(i);
      if (code2 === REVERSE_SOLIDUS2) {
        if (i === end) {
          if (i !== len - 1) {
            decoded = str.substr(i + 1);
          }
          break;
        }
        code2 = str.charCodeAt(++i);
        if (isValidEscape(REVERSE_SOLIDUS2, code2)) {
          const escapeStart = i - 1;
          const escapeEnd = consumeEscaped(str, escapeStart);
          i = escapeEnd - 1;
          decoded += decodeEscaped(str.substring(escapeStart + 1, escapeEnd));
        } else {
          if (code2 === 13 && str.charCodeAt(i + 1) === 10) {
            i++;
          }
        }
      } else {
        decoded += str[i];
      }
    }
    return decoded;
  }
  __name(decode2, "decode");
  function encode2(str) {
    let encoded = "";
    let wsBeforeHexIsNeeded = false;
    for (let i = 0; i < str.length; i++) {
      const code2 = str.charCodeAt(i);
      if (code2 === 0) {
        encoded += "\uFFFD";
        continue;
      }
      if (code2 <= 31 || code2 === 127) {
        encoded += "\\" + code2.toString(16);
        wsBeforeHexIsNeeded = true;
        continue;
      }
      if (code2 === SPACE || code2 === REVERSE_SOLIDUS2 || code2 === QUOTATION_MARK2 || code2 === APOSTROPHE2 || code2 === LEFTPARENTHESIS || code2 === RIGHTPARENTHESIS) {
        encoded += "\\" + str.charAt(i);
        wsBeforeHexIsNeeded = false;
      } else {
        if (wsBeforeHexIsNeeded && isHexDigit(code2)) {
          encoded += " ";
        }
        encoded += str.charAt(i);
        wsBeforeHexIsNeeded = false;
      }
    }
    return "url(" + encoded + ")";
  }
  __name(encode2, "encode");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Url.js
  var name47 = "Url";
  var structure47 = {
    value: String
  };
  function parse50() {
    const start = this.tokenStart;
    let value;
    switch (this.tokenType) {
      case Url:
        value = decode2(this.consume(Url));
        break;
      case Function:
        if (!this.cmpStr(this.tokenStart, this.tokenEnd, "url(")) {
          this.error("Function name must be `url`");
        }
        this.eat(Function);
        this.skipSC();
        value = decode(this.consume(String2));
        this.skipSC();
        if (!this.eof) {
          this.eat(RightParenthesis);
        }
        break;
      default:
        this.error("Url or Function is expected");
    }
    return {
      type: "Url",
      loc: this.getLocation(start, this.tokenStart),
      value
    };
  }
  __name(parse50, "parse");
  function generate48(node) {
    this.token(Url, encode2(node.value));
  }
  __name(generate48, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/Value.js
  var Value_exports = {};
  __export(Value_exports, {
    generate: () => generate49,
    name: () => name48,
    parse: () => parse51,
    structure: () => structure48
  });
  var name48 = "Value";
  var structure48 = {
    children: [[]]
  };
  function parse51() {
    const start = this.tokenStart;
    const children = this.readSequence(this.scope.Value);
    return {
      type: "Value",
      loc: this.getLocation(start, this.tokenStart),
      children
    };
  }
  __name(parse51, "parse");
  function generate49(node) {
    this.children(node);
  }
  __name(generate49, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/WhiteSpace.js
  var WhiteSpace_exports = {};
  __export(WhiteSpace_exports, {
    generate: () => generate50,
    name: () => name49,
    parse: () => parse52,
    structure: () => structure49
  });
  var SPACE2 = Object.freeze({
    type: "WhiteSpace",
    loc: null,
    value: " "
  });
  var name49 = "WhiteSpace";
  var structure49 = {
    value: String
  };
  function parse52() {
    this.eat(WhiteSpace);
    return SPACE2;
  }
  __name(parse52, "parse");
  function generate50(node) {
    this.token(WhiteSpace, node.value);
  }
  __name(generate50, "generate");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/config/parser.js
  var parser_default = {
    parseContext: {
      default: "StyleSheet",
      stylesheet: "StyleSheet",
      atrule: "Atrule",
      atrulePrelude(options) {
        return this.AtrulePrelude(options.atrule ? String(options.atrule) : null);
      },
      mediaQueryList: "MediaQueryList",
      mediaQuery: "MediaQuery",
      condition(options) {
        return this.Condition(options.kind);
      },
      rule: "Rule",
      selectorList: "SelectorList",
      selector: "Selector",
      block() {
        return this.Block(true);
      },
      declarationList: "DeclarationList",
      declaration: "Declaration",
      value: "Value"
    },
    features: {
      supports: {
        selector() {
          return this.Selector();
        }
      },
      container: {
        style() {
          return this.Declaration();
        }
      }
    },
    scope: scope_exports,
    atrule: atrule_default,
    pseudo: pseudo_default,
    node: index_parse_exports
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/parser/index.js
  var parser_default2 = createParser(parser_default);

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/generator/sourceMap.js
  var import_source_map_generator = __toESM(require_source_map_generator(), 1);
  var trackNodes = /* @__PURE__ */ new Set(["Atrule", "Selector", "Declaration"]);
  function generateSourceMap(handlers) {
    const map = new import_source_map_generator.SourceMapGenerator();
    const generated = {
      line: 1,
      column: 0
    };
    const original = {
      line: 0,
      // should be zero to add first mapping
      column: 0
    };
    const activatedGenerated = {
      line: 1,
      column: 0
    };
    const activatedMapping = {
      generated: activatedGenerated
    };
    let line = 1;
    let column = 0;
    let sourceMappingActive = false;
    const origHandlersNode = handlers.node;
    handlers.node = function(node) {
      if (node.loc && node.loc.start && trackNodes.has(node.type)) {
        const nodeLine = node.loc.start.line;
        const nodeColumn = node.loc.start.column - 1;
        if (original.line !== nodeLine || original.column !== nodeColumn) {
          original.line = nodeLine;
          original.column = nodeColumn;
          generated.line = line;
          generated.column = column;
          if (sourceMappingActive) {
            sourceMappingActive = false;
            if (generated.line !== activatedGenerated.line || generated.column !== activatedGenerated.column) {
              map.addMapping(activatedMapping);
            }
          }
          sourceMappingActive = true;
          map.addMapping({
            source: node.loc.source,
            original,
            generated
          });
        }
      }
      origHandlersNode.call(this, node);
      if (sourceMappingActive && trackNodes.has(node.type)) {
        activatedGenerated.line = line;
        activatedGenerated.column = column;
      }
    };
    const origHandlersEmit = handlers.emit;
    handlers.emit = function(value, type, auto) {
      for (let i = 0; i < value.length; i++) {
        if (value.charCodeAt(i) === 10) {
          line++;
          column = 0;
        } else {
          column++;
        }
      }
      origHandlersEmit(value, type, auto);
    };
    const origHandlersResult = handlers.result;
    handlers.result = function() {
      if (sourceMappingActive) {
        map.addMapping(activatedMapping);
      }
      return {
        css: origHandlersResult(),
        map
      };
    };
    return handlers;
  }
  __name(generateSourceMap, "generateSourceMap");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/generator/token-before.js
  var token_before_exports = {};
  __export(token_before_exports, {
    safe: () => safe,
    spec: () => spec
  });
  var PLUSSIGN7 = 43;
  var HYPHENMINUS5 = 45;
  var code = /* @__PURE__ */ __name((type, value) => {
    if (type === Delim) {
      type = value;
    }
    if (typeof type === "string") {
      type = Math.min(type.charCodeAt(0), 128) << 6;
    }
    return type << 1;
  }, "code");
  var specPairs = [
    [Ident, Ident],
    [Ident, Function],
    [Ident, Url],
    [Ident, BadUrl],
    [Ident, "-"],
    [Ident, Number2],
    [Ident, Percentage],
    [Ident, Dimension],
    [Ident, CDC],
    [Ident, LeftParenthesis],
    [AtKeyword, Ident],
    [AtKeyword, Function],
    [AtKeyword, Url],
    [AtKeyword, BadUrl],
    [AtKeyword, "-"],
    [AtKeyword, Number2],
    [AtKeyword, Percentage],
    [AtKeyword, Dimension],
    [AtKeyword, CDC],
    [Hash, Ident],
    [Hash, Function],
    [Hash, Url],
    [Hash, BadUrl],
    [Hash, "-"],
    [Hash, Number2],
    [Hash, Percentage],
    [Hash, Dimension],
    [Hash, CDC],
    [Dimension, Ident],
    [Dimension, Function],
    [Dimension, Url],
    [Dimension, BadUrl],
    [Dimension, "-"],
    [Dimension, Number2],
    [Dimension, Percentage],
    [Dimension, Dimension],
    [Dimension, CDC],
    ["#", Ident],
    ["#", Function],
    ["#", Url],
    ["#", BadUrl],
    ["#", "-"],
    ["#", Number2],
    ["#", Percentage],
    ["#", Dimension],
    ["#", CDC],
    // https://github.com/w3c/csswg-drafts/pull/6874
    ["-", Ident],
    ["-", Function],
    ["-", Url],
    ["-", BadUrl],
    ["-", "-"],
    ["-", Number2],
    ["-", Percentage],
    ["-", Dimension],
    ["-", CDC],
    // https://github.com/w3c/csswg-drafts/pull/6874
    [Number2, Ident],
    [Number2, Function],
    [Number2, Url],
    [Number2, BadUrl],
    [Number2, Number2],
    [Number2, Percentage],
    [Number2, Dimension],
    [Number2, "%"],
    [Number2, CDC],
    // https://github.com/w3c/csswg-drafts/pull/6874
    ["@", Ident],
    ["@", Function],
    ["@", Url],
    ["@", BadUrl],
    ["@", "-"],
    ["@", CDC],
    // https://github.com/w3c/csswg-drafts/pull/6874
    [".", Number2],
    [".", Percentage],
    [".", Dimension],
    ["+", Number2],
    ["+", Percentage],
    ["+", Dimension],
    ["/", "*"]
  ];
  var safePairs = specPairs.concat([
    [Ident, Hash],
    [Dimension, Hash],
    [Hash, Hash],
    [AtKeyword, LeftParenthesis],
    [AtKeyword, String2],
    [AtKeyword, Colon],
    [Percentage, Percentage],
    [Percentage, Dimension],
    [Percentage, Function],
    [Percentage, "-"],
    [RightParenthesis, Ident],
    [RightParenthesis, Function],
    [RightParenthesis, Percentage],
    [RightParenthesis, Dimension],
    [RightParenthesis, Hash],
    [RightParenthesis, "-"]
  ]);
  function createMap(pairs) {
    const isWhiteSpaceRequired = new Set(
      pairs.map(([prev, next]) => code(prev) << 16 | code(next))
    );
    return function(prevCode, type, value) {
      const nextCode = code(type, value);
      const nextCharCode = value.charCodeAt(0);
      const emitWs = nextCharCode === HYPHENMINUS5 && type !== Ident && type !== Function && type !== CDC || nextCharCode === PLUSSIGN7 ? isWhiteSpaceRequired.has((prevCode & 65534) << 16 | nextCharCode << 7) : isWhiteSpaceRequired.has((prevCode & 65534) << 16 | nextCode);
      return nextCode | emitWs;
    };
  }
  __name(createMap, "createMap");
  var spec = createMap(specPairs);
  var safe = createMap(safePairs);

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/generator/create.js
  var REVERSESOLIDUS = 92;
  function processChildren(node, delimeter) {
    if (typeof delimeter === "function") {
      let prev = null;
      node.children.forEach((node2) => {
        if (prev !== null) {
          delimeter.call(this, prev);
        }
        this.node(node2);
        prev = node2;
      });
      return;
    }
    node.children.forEach(this.node, this);
  }
  __name(processChildren, "processChildren");
  function createGenerator(config) {
    const types = /* @__PURE__ */ new Map();
    for (let [name50, item] of Object.entries(config.node)) {
      const fn = item.generate || item;
      if (typeof fn === "function") {
        types.set(name50, item.generate || item);
      }
    }
    return function(node, options) {
      let buffer = "";
      let prevCode = 0;
      let handlers = {
        node(node2) {
          if (types.has(node2.type)) {
            types.get(node2.type).call(publicApi, node2);
          } else {
            throw new Error("Unknown node type: " + node2.type);
          }
        },
        tokenBefore: safe,
        token(type, value, suppressAutoWhiteSpace) {
          prevCode = this.tokenBefore(prevCode, type, value);
          if (!suppressAutoWhiteSpace && prevCode & 1) {
            this.emit(" ", WhiteSpace, true);
          }
          this.emit(value, type, false);
          if (type === Delim && value.charCodeAt(0) === REVERSESOLIDUS) {
            this.emit("\n", WhiteSpace, true);
          }
        },
        emit(value) {
          buffer += value;
        },
        result() {
          return buffer;
        }
      };
      if (options) {
        if (typeof options.decorator === "function") {
          handlers = options.decorator(handlers);
        }
        if (options.sourceMap) {
          handlers = generateSourceMap(handlers);
        }
        if (options.mode in token_before_exports) {
          handlers.tokenBefore = token_before_exports[options.mode];
        }
      }
      const publicApi = {
        node: /* @__PURE__ */ __name((node2) => handlers.node(node2), "node"),
        children: processChildren,
        token: /* @__PURE__ */ __name((type, value) => handlers.token(type, value), "token"),
        tokenize: /* @__PURE__ */ __name((raw) => tokenize2(raw, (type, start, end) => {
          handlers.token(
            type,
            raw.slice(start, end),
            start !== 0
            // suppress auto whitespace for internal value tokens
          );
        }), "tokenize")
      };
      handlers.node(node);
      return handlers.result();
    };
  }
  __name(createGenerator, "createGenerator");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/index-generate.js
  var index_generate_exports = {};
  __export(index_generate_exports, {
    AnPlusB: () => generate2,
    Atrule: () => generate3,
    AtrulePrelude: () => generate4,
    AttributeSelector: () => generate5,
    Block: () => generate6,
    Brackets: () => generate7,
    CDC: () => generate8,
    CDO: () => generate9,
    ClassSelector: () => generate10,
    Combinator: () => generate11,
    Comment: () => generate12,
    Condition: () => generate13,
    Declaration: () => generate14,
    DeclarationList: () => generate15,
    Dimension: () => generate16,
    Feature: () => generate17,
    FeatureFunction: () => generate18,
    FeatureRange: () => generate19,
    Function: () => generate20,
    GeneralEnclosed: () => generate21,
    Hash: () => generate22,
    IdSelector: () => generate24,
    Identifier: () => generate23,
    Layer: () => generate25,
    LayerList: () => generate26,
    MediaQuery: () => generate27,
    MediaQueryList: () => generate28,
    NestingSelector: () => generate29,
    Nth: () => generate30,
    Number: () => generate31,
    Operator: () => generate32,
    Parentheses: () => generate33,
    Percentage: () => generate34,
    PseudoClassSelector: () => generate35,
    PseudoElementSelector: () => generate36,
    Ratio: () => generate37,
    Raw: () => generate38,
    Rule: () => generate39,
    Scope: () => generate40,
    Selector: () => generate41,
    SelectorList: () => generate42,
    String: () => generate43,
    StyleSheet: () => generate44,
    SupportsDeclaration: () => generate45,
    TypeSelector: () => generate46,
    UnicodeRange: () => generate47,
    Url: () => generate48,
    Value: () => generate49,
    WhiteSpace: () => generate50
  });

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/config/generator.js
  var generator_default = {
    node: index_generate_exports
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/generator/index.js
  var generator_default2 = createGenerator(generator_default);

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/walker/create.js
  var { hasOwnProperty: hasOwnProperty2 } = Object.prototype;
  var noop = /* @__PURE__ */ __name(function() {
  }, "noop");
  function ensureFunction(value) {
    return typeof value === "function" ? value : noop;
  }
  __name(ensureFunction, "ensureFunction");
  function invokeForType(fn, type) {
    return function(node, item, list) {
      if (node.type === type) {
        fn.call(this, node, item, list);
      }
    };
  }
  __name(invokeForType, "invokeForType");
  function getWalkersFromStructure(name50, nodeType) {
    const structure50 = nodeType.structure;
    const walkers = [];
    for (const key in structure50) {
      if (hasOwnProperty2.call(structure50, key) === false) {
        continue;
      }
      let fieldTypes = structure50[key];
      const walker = {
        name: key,
        type: false,
        nullable: false
      };
      if (!Array.isArray(fieldTypes)) {
        fieldTypes = [fieldTypes];
      }
      for (const fieldType of fieldTypes) {
        if (fieldType === null) {
          walker.nullable = true;
        } else if (typeof fieldType === "string") {
          walker.type = "node";
        } else if (Array.isArray(fieldType)) {
          walker.type = "list";
        }
      }
      if (walker.type) {
        walkers.push(walker);
      }
    }
    if (walkers.length) {
      return {
        context: nodeType.walkContext,
        fields: walkers
      };
    }
    return null;
  }
  __name(getWalkersFromStructure, "getWalkersFromStructure");
  function getTypesFromConfig(config) {
    const types = {};
    for (const name50 in config.node) {
      if (hasOwnProperty2.call(config.node, name50)) {
        const nodeType = config.node[name50];
        if (!nodeType.structure) {
          throw new Error("Missed `structure` field in `" + name50 + "` node type definition");
        }
        types[name50] = getWalkersFromStructure(name50, nodeType);
      }
    }
    return types;
  }
  __name(getTypesFromConfig, "getTypesFromConfig");
  function createTypeIterator(config, reverse) {
    const fields = config.fields.slice();
    const contextName = config.context;
    const useContext = typeof contextName === "string";
    if (reverse) {
      fields.reverse();
    }
    return function(node, context, walk, walkReducer) {
      let prevContextValue;
      if (useContext) {
        prevContextValue = context[contextName];
        context[contextName] = node;
      }
      for (const field of fields) {
        const ref = node[field.name];
        if (!field.nullable || ref) {
          if (field.type === "list") {
            const breakWalk = reverse ? ref.reduceRight(walkReducer, false) : ref.reduce(walkReducer, false);
            if (breakWalk) {
              return true;
            }
          } else if (walk(ref)) {
            return true;
          }
        }
      }
      if (useContext) {
        context[contextName] = prevContextValue;
      }
    };
  }
  __name(createTypeIterator, "createTypeIterator");
  function createFastTraveralMap({
    StyleSheet,
    Atrule,
    Rule,
    Block,
    DeclarationList
  }) {
    return {
      Atrule: {
        StyleSheet,
        Atrule,
        Rule,
        Block
      },
      Rule: {
        StyleSheet,
        Atrule,
        Rule,
        Block
      },
      Declaration: {
        StyleSheet,
        Atrule,
        Rule,
        Block,
        DeclarationList
      }
    };
  }
  __name(createFastTraveralMap, "createFastTraveralMap");
  function createWalker(config) {
    const types = getTypesFromConfig(config);
    const iteratorsNatural = {};
    const iteratorsReverse = {};
    const breakWalk = /* @__PURE__ */ Symbol("break-walk");
    const skipNode = /* @__PURE__ */ Symbol("skip-node");
    for (const name50 in types) {
      if (hasOwnProperty2.call(types, name50) && types[name50] !== null) {
        iteratorsNatural[name50] = createTypeIterator(types[name50], false);
        iteratorsReverse[name50] = createTypeIterator(types[name50], true);
      }
    }
    const fastTraversalIteratorsNatural = createFastTraveralMap(iteratorsNatural);
    const fastTraversalIteratorsReverse = createFastTraveralMap(iteratorsReverse);
    const walk = /* @__PURE__ */ __name(function(root, options) {
      function walkNode(node, item, list) {
        const enterRet = enter.call(context, node, item, list);
        if (enterRet === breakWalk) {
          return true;
        }
        if (enterRet === skipNode) {
          return false;
        }
        if (iterators.hasOwnProperty(node.type)) {
          if (iterators[node.type](node, context, walkNode, walkReducer)) {
            return true;
          }
        }
        if (leave.call(context, node, item, list) === breakWalk) {
          return true;
        }
        return false;
      }
      __name(walkNode, "walkNode");
      let enter = noop;
      let leave = noop;
      let iterators = iteratorsNatural;
      let walkReducer = /* @__PURE__ */ __name((ret, data, item, list) => ret || walkNode(data, item, list), "walkReducer");
      const context = {
        break: breakWalk,
        skip: skipNode,
        root,
        stylesheet: null,
        atrule: null,
        atrulePrelude: null,
        rule: null,
        selector: null,
        block: null,
        declaration: null,
        function: null
      };
      if (typeof options === "function") {
        enter = options;
      } else if (options) {
        enter = ensureFunction(options.enter);
        leave = ensureFunction(options.leave);
        if (options.reverse) {
          iterators = iteratorsReverse;
        }
        if (options.visit) {
          if (fastTraversalIteratorsNatural.hasOwnProperty(options.visit)) {
            iterators = options.reverse ? fastTraversalIteratorsReverse[options.visit] : fastTraversalIteratorsNatural[options.visit];
          } else if (!types.hasOwnProperty(options.visit)) {
            throw new Error("Bad value `" + options.visit + "` for `visit` option (should be: " + Object.keys(types).sort().join(", ") + ")");
          }
          enter = invokeForType(enter, options.visit);
          leave = invokeForType(leave, options.visit);
        }
      }
      if (enter === noop && leave === noop) {
        throw new Error("Neither `enter` nor `leave` walker handler is set or both aren't a function");
      }
      walkNode(root);
    }, "walk");
    walk.break = breakWalk;
    walk.skip = skipNode;
    walk.find = function(ast, fn) {
      let found = null;
      walk(ast, function(node, item, list) {
        if (fn.call(this, node, item, list)) {
          found = node;
          return breakWalk;
        }
      });
      return found;
    };
    walk.findLast = function(ast, fn) {
      let found = null;
      walk(ast, {
        reverse: true,
        enter(node, item, list) {
          if (fn.call(this, node, item, list)) {
            found = node;
            return breakWalk;
          }
        }
      });
      return found;
    };
    walk.findAll = function(ast, fn) {
      const found = [];
      walk(ast, function(node, item, list) {
        if (fn.call(this, node, item, list)) {
          found.push(node);
        }
      });
      return found;
    };
    return walk;
  }
  __name(createWalker, "createWalker");

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/node/index.js
  var node_exports = {};
  __export(node_exports, {
    AnPlusB: () => AnPlusB_exports,
    Atrule: () => Atrule_exports,
    AtrulePrelude: () => AtrulePrelude_exports,
    AttributeSelector: () => AttributeSelector_exports,
    Block: () => Block_exports,
    Brackets: () => Brackets_exports,
    CDC: () => CDC_exports,
    CDO: () => CDO_exports,
    ClassSelector: () => ClassSelector_exports,
    Combinator: () => Combinator_exports,
    Comment: () => Comment_exports,
    Condition: () => Condition_exports,
    Declaration: () => Declaration_exports,
    DeclarationList: () => DeclarationList_exports,
    Dimension: () => Dimension_exports,
    Feature: () => Feature_exports,
    FeatureFunction: () => FeatureFunction_exports,
    FeatureRange: () => FeatureRange_exports,
    Function: () => Function_exports,
    GeneralEnclosed: () => GeneralEnclosed_exports,
    Hash: () => Hash_exports,
    IdSelector: () => IdSelector_exports,
    Identifier: () => Identifier_exports,
    Layer: () => Layer_exports,
    LayerList: () => LayerList_exports,
    MediaQuery: () => MediaQuery_exports,
    MediaQueryList: () => MediaQueryList_exports,
    NestingSelector: () => NestingSelector_exports,
    Nth: () => Nth_exports,
    Number: () => Number_exports,
    Operator: () => Operator_exports,
    Parentheses: () => Parentheses_exports,
    Percentage: () => Percentage_exports,
    PseudoClassSelector: () => PseudoClassSelector_exports,
    PseudoElementSelector: () => PseudoElementSelector_exports,
    Ratio: () => Ratio_exports,
    Raw: () => Raw_exports,
    Rule: () => Rule_exports,
    Scope: () => Scope_exports,
    Selector: () => Selector_exports,
    SelectorList: () => SelectorList_exports,
    String: () => String_exports,
    StyleSheet: () => StyleSheet_exports,
    SupportsDeclaration: () => SupportsDeclaration_exports,
    TypeSelector: () => TypeSelector_exports,
    UnicodeRange: () => UnicodeRange_exports,
    Url: () => Url_exports,
    Value: () => Value_exports,
    WhiteSpace: () => WhiteSpace_exports
  });

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/syntax/config/walker.js
  var walker_default = {
    node: node_exports
  };

  // node_modules/.pnpm/css-tree@3.2.1_patch_hash=815076d806522c85822ee571849fef1c4bfd07dba223f6500bdba1b7a33654b4/node_modules/css-tree/lib/walker/index.js
  var walker_default2 = createWalker(walker_default);

  // vendor/src/vendor.entry.js
  var cssTree = { parse: parser_default2, generate: generator_default2, walk: walker_default2 };
  return __toCommonJS(vendor_entry_exports);
})();
