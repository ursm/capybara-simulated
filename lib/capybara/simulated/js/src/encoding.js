// `btoa` / `atob` / `TextEncoder` / `TextDecoder` — WindowOrWorker
// GlobalScope base64 + UTF-8 codecs. No bridge dependencies; pure
// data conversion.

import { getEncoding } from './encodings.js';

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = (function () {
  const m = new Uint8Array(256);
  for (let i = 0; i < 256; i++) m[i] = 255;
  for (let i = 0; i < 64; i++) m[B64_CHARS.charCodeAt(i)] = i;
  return m;
})();

// Spec restricts input to Latin1 (each codepoint ≤ 0xFF); higher
// codepoints throw `InvalidCharacterError`. Apps that need Unicode
// base64 wrap their input through `encodeURIComponent` and the
// `%XX → char` round-trip (Forem's `base64EncodeUnicode`), so
// matching real-browser behaviour is what unlocks them.
export function btoa(data) {
  const s = String(data);
  let out = '';
  for (let i = 0; i < s.length; i += 3) {
    const c1 = s.charCodeAt(i);
    const c2 = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN;
    const c3 = i + 2 < s.length ? s.charCodeAt(i + 2) : NaN;
    if (c1 > 0xff || (i + 1 < s.length && c2 > 0xff) || (i + 2 < s.length && c3 > 0xff)) {
      throw new Error("InvalidCharacterError: 'btoa' input contained non-Latin1 char");
    }
    const b1 = c1 >> 2;
    const b2 = ((c1 & 3) << 4) | (Number.isNaN(c2) ? 0 : (c2 >> 4));
    const b3 = Number.isNaN(c2) ? 64 : (((c2 & 15) << 2) | (Number.isNaN(c3) ? 0 : (c3 >> 6)));
    const b4 = Number.isNaN(c3) ? 64 : (c3 & 63);
    out += B64_CHARS[b1] + B64_CHARS[b2] +
           (b3 === 64 ? '=' : B64_CHARS[b3]) +
           (b4 === 64 ? '=' : B64_CHARS[b4]);
  }
  return out;
}

export function atob(data) {
  let s = String(data).replace(/[\t\n\f\r ]/g, '');
  if (s.length % 4 === 1) throw new Error("InvalidCharacterError: bad 'atob' length");
  s = s.replace(/=+$/, '');
  let out = '';
  let bits = 0, value = 0;
  for (let i = 0; i < s.length; i++) {
    const idx = B64_INDEX[s.charCodeAt(i)];
    if (idx === 255) throw new Error("InvalidCharacterError: bad 'atob' char");
    value = (value << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  return out;
}

// Per spec the encoder is UTF-8 exclusive; decoder defaults to UTF-8.
// Avo's `filter_controller` round-trips its encoded_filters payload
// via `btoa(String.fromCodePoint(...new TextEncoder().encode(...)))`
// and `new TextDecoder().decode(Uint8Array.from(atob(...), ...))`;
// without these the controller throws on `changeFilter`, the
// redirect-target href stays stale, and the filters panel never
// navigates → "User names filter" stays visible in
// filters_panel_open_spec's "keeps the panel closed on selection".

export class TextEncoder {
  get encoding() { return 'utf-8'; }
  encode(input) {
    const s = String(input == null ? '' : input);
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      let cp = s.charCodeAt(i);
      if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < s.length) {
        const low = s.charCodeAt(i + 1);
        if (low >= 0xDC00 && low <= 0xDFFF) {
          cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
          i++;
        }
      }
      // WHATWG UTF-8 encoder: an unpaired surrogate becomes U+FFFD (not WTF-8).
      if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD;
      if (cp < 0x80) {
        bytes.push(cp);
      } else if (cp < 0x800) {
        bytes.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F));
      } else if (cp < 0x10000) {
        bytes.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else {
        bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
                   0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      }
    }
    return new Uint8Array(bytes);
  }
  // WHATWG `encodeInto`: UTF-8-encode `source` into the `destination`
  // Uint8Array, never writing a partial code point. Returns
  // `{read, written}` — `read` counts UTF-16 code units consumed,
  // `written` counts bytes emitted. Stops at the first code point that
  // wouldn't fit in the remaining space.
  encodeInto(source, destination) {
    if (!(destination instanceof Uint8Array)) {
      throw new TypeError("Failed to execute 'encodeInto' on 'TextEncoder': destination is not a Uint8Array.");
    }
    const s   = String(source == null ? '' : source);
    const cap = destination.length;
    let read = 0, written = 0;
    for (let i = 0; i < s.length;) {
      let cp = s.charCodeAt(i);
      let units = 1;
      if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < s.length) {
        const low = s.charCodeAt(i + 1);
        if (low >= 0xDC00 && low <= 0xDFFF) {
          cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
          units = 2;
        }
      }
      if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD; // unpaired surrogate
      const need = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      if (written + need > cap) break;
      if (need === 1) {
        destination[written++] = cp;
      } else if (need === 2) {
        destination[written++] = 0xC0 | (cp >> 6);
        destination[written++] = 0x80 | (cp & 0x3F);
      } else if (need === 3) {
        destination[written++] = 0xE0 | (cp >> 12);
        destination[written++] = 0x80 | ((cp >> 6) & 0x3F);
        destination[written++] = 0x80 | (cp & 0x3F);
      } else {
        destination[written++] = 0xF0 | (cp >> 18);
        destination[written++] = 0x80 | ((cp >> 12) & 0x3F);
        destination[written++] = 0x80 | ((cp >> 6) & 0x3F);
        destination[written++] = 0x80 | (cp & 0x3F);
      }
      read += units;
      i   += units;
    }
    return {read, written};
  }
}

// WHATWG single-byte decoder index tables (encoding.spec.whatwg.org/indexes.json),
// each 128 entries for bytes 0x80-0xFF (null = undefined slot -> U+FFFD / fatal
// throw). Extracted verbatim from the vendored single-byte-decoder.window.js.
// windows-1252 (the iso-8859-1 / ascii decode target) is one of these.
const SINGLE_BYTE_INDEXES = {
  "IBM866": [1040,1041,1042,1043,1044,1045,1046,1047,1048,1049,1050,1051,1052,1053,1054,1055,1056,1057,1058,1059,1060,1061,1062,1063,1064,1065,1066,1067,1068,1069,1070,1071,1072,1073,1074,1075,1076,1077,1078,1079,1080,1081,1082,1083,1084,1085,1086,1087,9617,9618,9619,9474,9508,9569,9570,9558,9557,9571,9553,9559,9565,9564,9563,9488,9492,9524,9516,9500,9472,9532,9566,9567,9562,9556,9577,9574,9568,9552,9580,9575,9576,9572,9573,9561,9560,9554,9555,9579,9578,9496,9484,9608,9604,9612,9616,9600,1088,1089,1090,1091,1092,1093,1094,1095,1096,1097,1098,1099,1100,1101,1102,1103,1025,1105,1028,1108,1031,1111,1038,1118,176,8729,183,8730,8470,164,9632,160],
  "ISO-8859-10": [128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,260,274,290,298,296,310,167,315,272,352,358,381,173,362,330,176,261,275,291,299,297,311,183,316,273,353,359,382,8213,363,331,256,193,194,195,196,197,198,302,268,201,280,203,278,205,206,207,208,325,332,211,212,213,214,360,216,370,218,219,220,221,222,223,257,225,226,227,228,229,230,303,269,233,281,235,279,237,238,239,240,326,333,243,244,245,246,361,248,371,250,251,252,253,254,312],
  "ISO-8859-13": [128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,8221,162,163,164,8222,166,167,216,169,342,171,172,173,174,198,176,177,178,179,8220,181,182,183,248,185,343,187,188,189,190,230,260,302,256,262,196,197,280,274,268,201,377,278,290,310,298,315,352,323,325,211,332,213,214,215,370,321,346,362,220,379,381,223,261,303,257,263,228,229,281,275,269,233,378,279,291,311,299,316,353,324,326,243,333,245,246,247,371,322,347,363,252,380,382,8217],
  "ISO-8859-14": [128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,7682,7683,163,266,267,7690,167,7808,169,7810,7691,7922,173,174,376,7710,7711,288,289,7744,7745,182,7766,7809,7767,7811,7776,7923,7812,7813,7777,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,372,209,210,211,212,213,214,7786,216,217,218,219,220,221,374,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,373,241,242,243,244,245,246,7787,248,249,250,251,252,253,375,255],
  "ISO-8859-15": [128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163,8364,165,352,167,353,169,170,171,172,173,174,175,176,177,178,179,381,181,182,183,382,185,186,187,338,339,376,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255],
  "ISO-8859-16": [128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,260,261,321,8364,8222,352,167,353,169,536,171,377,173,378,379,176,177,268,322,381,8221,182,183,382,269,537,187,338,339,376,380,192,193,194,258,196,262,198,199,200,201,202,203,204,205,206,207,272,323,210,211,212,336,214,346,368,217,218,219,220,280,538,223,224,225,226,259,228,263,230,231,232,233,234,235,236,237,238,239,273,324,242,243,244,337,246,347,369,249,250,251,252,281,539,255],
  "ISO-8859-2": [128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,260,728,321,164,317,346,167,168,352,350,356,377,173,381,379,176,261,731,322,180,318,347,711,184,353,351,357,378,733,382,380,340,193,194,258,196,313,262,199,268,201,280,203,282,205,206,270,272,323,327,211,212,336,214,215,344,366,218,368,220,221,354,223,341,225,226,259,228,314,263,231,269,233,281,235,283,237,238,271,273,324,328,243,244,337,246,247,345,367,250,369,252,253,355,729],
  "ISO-8859-3": [128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,294,728,163,164,null,292,167,168,304,350,286,308,173,null,379,176,295,178,179,180,181,293,183,184,305,351,287,309,189,null,380,192,193,194,null,196,266,264,199,200,201,202,203,204,205,206,207,null,209,210,211,212,288,214,215,284,217,218,219,220,364,348,223,224,225,226,null,228,267,265,231,232,233,234,235,236,237,238,239,null,241,242,243,244,289,246,247,285,249,250,251,252,365,349,729],
  "ISO-8859-4": [128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,260,312,342,164,296,315,167,168,352,274,290,358,173,381,175,176,261,731,343,180,297,316,711,184,353,275,291,359,330,382,331,256,193,194,195,196,197,198,302,268,201,280,203,278,205,206,298,272,325,332,310,212,213,214,215,216,370,218,219,220,360,362,223,257,225,226,227,228,229,230,303,269,233,281,235,279,237,238,299,273,326,333,311,244,245,246,247,248,371,250,251,252,361,363,729],
  "ISO-8859-5": [128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,1025,1026,1027,1028,1029,1030,1031,1032,1033,1034,1035,1036,173,1038,1039,1040,1041,1042,1043,1044,1045,1046,1047,1048,1049,1050,1051,1052,1053,1054,1055,1056,1057,1058,1059,1060,1061,1062,1063,1064,1065,1066,1067,1068,1069,1070,1071,1072,1073,1074,1075,1076,1077,1078,1079,1080,1081,1082,1083,1084,1085,1086,1087,1088,1089,1090,1091,1092,1093,1094,1095,1096,1097,1098,1099,1100,1101,1102,1103,8470,1105,1106,1107,1108,1109,1110,1111,1112,1113,1114,1115,1116,167,1118,1119],
  "ISO-8859-6": [128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,null,null,null,164,null,null,null,null,null,null,null,1548,173,null,null,null,null,null,null,null,null,null,null,null,null,null,1563,null,null,null,1567,null,1569,1570,1571,1572,1573,1574,1575,1576,1577,1578,1579,1580,1581,1582,1583,1584,1585,1586,1587,1588,1589,1590,1591,1592,1593,1594,null,null,null,null,null,1600,1601,1602,1603,1604,1605,1606,1607,1608,1609,1610,1611,1612,1613,1614,1615,1616,1617,1618,null,null,null,null,null,null,null,null,null,null,null,null,null],
  "ISO-8859-7": [128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,8216,8217,163,8364,8367,166,167,168,169,890,171,172,173,null,8213,176,177,178,179,900,901,902,183,904,905,906,187,908,189,910,911,912,913,914,915,916,917,918,919,920,921,922,923,924,925,926,927,928,929,null,931,932,933,934,935,936,937,938,939,940,941,942,943,944,945,946,947,948,949,950,951,952,953,954,955,956,957,958,959,960,961,962,963,964,965,966,967,968,969,970,971,972,973,974,null],
  "ISO-8859-8": [128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,null,162,163,164,165,166,167,168,169,215,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,247,187,188,189,190,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,8215,1488,1489,1490,1491,1492,1493,1494,1495,1496,1497,1498,1499,1500,1501,1502,1503,1504,1505,1506,1507,1508,1509,1510,1511,1512,1513,1514,null,null,8206,8207,null],
  "KOI8-R": [9472,9474,9484,9488,9492,9496,9500,9508,9516,9524,9532,9600,9604,9608,9612,9616,9617,9618,9619,8992,9632,8729,8730,8776,8804,8805,160,8993,176,178,183,247,9552,9553,9554,1105,9555,9556,9557,9558,9559,9560,9561,9562,9563,9564,9565,9566,9567,9568,9569,1025,9570,9571,9572,9573,9574,9575,9576,9577,9578,9579,9580,169,1102,1072,1073,1094,1076,1077,1092,1075,1093,1080,1081,1082,1083,1084,1085,1086,1087,1103,1088,1089,1090,1091,1078,1074,1100,1099,1079,1096,1101,1097,1095,1098,1070,1040,1041,1062,1044,1045,1060,1043,1061,1048,1049,1050,1051,1052,1053,1054,1055,1071,1056,1057,1058,1059,1046,1042,1068,1067,1047,1064,1069,1065,1063,1066],
  "KOI8-U": [9472,9474,9484,9488,9492,9496,9500,9508,9516,9524,9532,9600,9604,9608,9612,9616,9617,9618,9619,8992,9632,8729,8730,8776,8804,8805,160,8993,176,178,183,247,9552,9553,9554,1105,1108,9556,1110,1111,9559,9560,9561,9562,9563,1169,1118,9566,9567,9568,9569,1025,1028,9571,1030,1031,9574,9575,9576,9577,9578,1168,1038,169,1102,1072,1073,1094,1076,1077,1092,1075,1093,1080,1081,1082,1083,1084,1085,1086,1087,1103,1088,1089,1090,1091,1078,1074,1100,1099,1079,1096,1101,1097,1095,1098,1070,1040,1041,1062,1044,1045,1060,1043,1061,1048,1049,1050,1051,1052,1053,1054,1055,1071,1056,1057,1058,1059,1046,1042,1068,1067,1047,1064,1069,1065,1063,1066],
  "macintosh": [196,197,199,201,209,214,220,225,224,226,228,227,229,231,233,232,234,235,237,236,238,239,241,243,242,244,246,245,250,249,251,252,8224,176,162,163,167,8226,182,223,174,169,8482,180,168,8800,198,216,8734,177,8804,8805,165,181,8706,8721,8719,960,8747,170,186,937,230,248,191,161,172,8730,402,8776,8710,171,187,8230,160,192,195,213,338,339,8211,8212,8220,8221,8216,8217,247,9674,255,376,8260,8364,8249,8250,64257,64258,8225,183,8218,8222,8240,194,202,193,203,200,205,206,207,204,211,212,63743,210,218,219,217,305,710,732,175,728,729,730,184,733,731,711],
  "windows-1250": [8364,129,8218,131,8222,8230,8224,8225,136,8240,352,8249,346,356,381,377,144,8216,8217,8220,8221,8226,8211,8212,152,8482,353,8250,347,357,382,378,160,711,728,321,164,260,166,167,168,169,350,171,172,173,174,379,176,177,731,322,180,181,182,183,184,261,351,187,317,733,318,380,340,193,194,258,196,313,262,199,268,201,280,203,282,205,206,270,272,323,327,211,212,336,214,215,344,366,218,368,220,221,354,223,341,225,226,259,228,314,263,231,269,233,281,235,283,237,238,271,273,324,328,243,244,337,246,247,345,367,250,369,252,253,355,729],
  "windows-1251": [1026,1027,8218,1107,8222,8230,8224,8225,8364,8240,1033,8249,1034,1036,1035,1039,1106,8216,8217,8220,8221,8226,8211,8212,152,8482,1113,8250,1114,1116,1115,1119,160,1038,1118,1032,164,1168,166,167,1025,169,1028,171,172,173,174,1031,176,177,1030,1110,1169,181,182,183,1105,8470,1108,187,1112,1029,1109,1111,1040,1041,1042,1043,1044,1045,1046,1047,1048,1049,1050,1051,1052,1053,1054,1055,1056,1057,1058,1059,1060,1061,1062,1063,1064,1065,1066,1067,1068,1069,1070,1071,1072,1073,1074,1075,1076,1077,1078,1079,1080,1081,1082,1083,1084,1085,1086,1087,1088,1089,1090,1091,1092,1093,1094,1095,1096,1097,1098,1099,1100,1101,1102,1103],
  "windows-1252": [8364,129,8218,402,8222,8230,8224,8225,710,8240,352,8249,338,141,381,143,144,8216,8217,8220,8221,8226,8211,8212,732,8482,353,8250,339,157,382,376,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255],
  "windows-1253": [8364,129,8218,402,8222,8230,8224,8225,136,8240,138,8249,140,141,142,143,144,8216,8217,8220,8221,8226,8211,8212,152,8482,154,8250,156,157,158,159,160,901,902,163,164,165,166,167,168,169,null,171,172,173,174,8213,176,177,178,179,900,181,182,183,904,905,906,187,908,189,910,911,912,913,914,915,916,917,918,919,920,921,922,923,924,925,926,927,928,929,null,931,932,933,934,935,936,937,938,939,940,941,942,943,944,945,946,947,948,949,950,951,952,953,954,955,956,957,958,959,960,961,962,963,964,965,966,967,968,969,970,971,972,973,974,null],
  "windows-1254": [8364,129,8218,402,8222,8230,8224,8225,710,8240,352,8249,338,141,142,143,144,8216,8217,8220,8221,8226,8211,8212,732,8482,353,8250,339,157,158,376,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,286,209,210,211,212,213,214,215,216,217,218,219,220,304,350,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,287,241,242,243,244,245,246,247,248,249,250,251,252,305,351,255],
  "windows-1255": [8364,129,8218,402,8222,8230,8224,8225,710,8240,138,8249,140,141,142,143,144,8216,8217,8220,8221,8226,8211,8212,732,8482,154,8250,156,157,158,159,160,161,162,163,8362,165,166,167,168,169,215,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,247,187,188,189,190,191,1456,1457,1458,1459,1460,1461,1462,1463,1464,1465,1466,1467,1468,1469,1470,1471,1472,1473,1474,1475,1520,1521,1522,1523,1524,null,null,null,null,null,null,null,1488,1489,1490,1491,1492,1493,1494,1495,1496,1497,1498,1499,1500,1501,1502,1503,1504,1505,1506,1507,1508,1509,1510,1511,1512,1513,1514,null,null,8206,8207,null],
  "windows-1256": [8364,1662,8218,402,8222,8230,8224,8225,710,8240,1657,8249,338,1670,1688,1672,1711,8216,8217,8220,8221,8226,8211,8212,1705,8482,1681,8250,339,8204,8205,1722,160,1548,162,163,164,165,166,167,168,169,1726,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,1563,187,188,189,190,1567,1729,1569,1570,1571,1572,1573,1574,1575,1576,1577,1578,1579,1580,1581,1582,1583,1584,1585,1586,1587,1588,1589,1590,215,1591,1592,1593,1594,1600,1601,1602,1603,224,1604,226,1605,1606,1607,1608,231,232,233,234,235,1609,1610,238,239,1611,1612,1613,1614,244,1615,1616,247,1617,249,1618,251,252,8206,8207,1746],
  "windows-1257": [8364,129,8218,131,8222,8230,8224,8225,136,8240,138,8249,140,168,711,184,144,8216,8217,8220,8221,8226,8211,8212,152,8482,154,8250,156,175,731,159,160,null,162,163,164,null,166,167,216,169,342,171,172,173,174,198,176,177,178,179,180,181,182,183,248,185,343,187,188,189,190,230,260,302,256,262,196,197,280,274,268,201,377,278,290,310,298,315,352,323,325,211,332,213,214,215,370,321,346,362,220,379,381,223,261,303,257,263,228,229,281,275,269,233,378,279,291,311,299,316,353,324,326,243,333,245,246,247,371,322,347,363,252,380,382,729],
  "windows-1258": [8364,129,8218,402,8222,8230,8224,8225,710,8240,138,8249,338,141,142,143,144,8216,8217,8220,8221,8226,8211,8212,732,8482,154,8250,339,157,158,376,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,258,196,197,198,199,200,201,202,203,768,205,206,207,272,209,777,211,212,416,214,215,216,217,218,219,220,431,771,223,224,225,226,259,228,229,230,231,232,233,234,235,769,237,238,239,273,241,803,243,244,417,246,247,248,249,250,251,252,432,8363,255],
  "windows-874": [8364,129,130,131,132,8230,134,135,136,137,138,139,140,141,142,143,144,8216,8217,8220,8221,8226,8211,8212,152,153,154,155,156,157,158,159,160,3585,3586,3587,3588,3589,3590,3591,3592,3593,3594,3595,3596,3597,3598,3599,3600,3601,3602,3603,3604,3605,3606,3607,3608,3609,3610,3611,3612,3613,3614,3615,3616,3617,3618,3619,3620,3621,3622,3623,3624,3625,3626,3627,3628,3629,3630,3631,3632,3633,3634,3635,3636,3637,3638,3639,3640,3641,3642,null,null,null,null,3647,3648,3649,3650,3651,3652,3653,3654,3655,3656,3657,3658,3659,3660,3661,3662,3663,3664,3665,3666,3667,3668,3669,3670,3671,3672,3673,3674,3675,null,null,null,null],
  "x-mac-cyrillic": [1040,1041,1042,1043,1044,1045,1046,1047,1048,1049,1050,1051,1052,1053,1054,1055,1056,1057,1058,1059,1060,1061,1062,1063,1064,1065,1066,1067,1068,1069,1070,1071,8224,176,1168,163,167,8226,182,1030,174,169,8482,1026,1106,8800,1027,1107,8734,177,8804,8805,1110,181,1169,1032,1028,1108,1031,1111,1033,1113,1034,1114,1112,1029,172,8730,402,8776,8710,171,187,8230,160,1035,1115,1036,1116,1109,8211,8212,8220,8221,8216,8217,247,8222,1038,1118,1039,1119,8470,1025,1105,1103,1072,1073,1074,1075,1076,1077,1078,1079,1080,1081,1082,1083,1084,1085,1086,1087,1088,1089,1090,1091,1092,1093,1094,1095,1096,1097,1098,1099,1100,1101,1102,8364]
};
// ISO-8859-8-I (logical Hebrew) is a distinct canonical name that decodes through
// the SAME index as ISO-8859-8 (visual) — WHATWG indexes.json carries one table.
SINGLE_BYTE_INDEXES['ISO-8859-8-I'] = SINGLE_BYTE_INDEXES['ISO-8859-8'];

// Inverse of a single-byte index: code point → output byte (0x80–0xFF). The
// WHATWG single-byte encoder's "index pointer" is the FIRST index whose entry is
// the code point, so the first occurrence wins. Built lazily + cached per
// encoding (the form-submission path is cold; no eager allocation).
const INVERSE_SINGLE_BYTE = {};
function inverseSingleByte(name) {
  let inv = INVERSE_SINGLE_BYTE[name];
  if (inv) return inv;
  const table = SINGLE_BYTE_INDEXES[name];
  if (!table) return null;
  inv = new Map();
  for (let i = 0; i < table.length; i++) {
    const cp = table[i];
    if (cp != null && !inv.has(cp)) inv.set(cp, 0x80 + i);
  }
  return (INVERSE_SINGLE_BYTE[name] = inv);
}

// Whether `name` (a canonical WHATWG encoding name) is a single-byte legacy
// encoding we can encode INTO. UTF-8 / UTF-16 / x-user-defined / the legacy
// multibyte CJK encodings are not (the form-submission path keeps its UTF-8
// route for those).
export function isSingleByteEncoding(name) { return !!SINGLE_BYTE_INDEXES[name]; }

// HTML "encode" for a form's submission character set, single-byte legacy
// branch: returns a BYTE STRING (each char code 0x00–0xFF is one output byte).
// An ASCII code point maps to itself; a non-ASCII one to the encoding's byte if
// representable, else to a decimal numeric character reference `&#N;` (the
// "html" encoder error mode). A lone surrogate first becomes U+FFFD (which is
// itself unrepresentable in every legacy single-byte set → `&#65533;`). Callers
// gate on `isSingleByteEncoding(name)`; UTF-8 keeps its own (TextEncoder) path.
export function legacyFormEncode(str, name) {
  const inv = inverseSingleByte(name);
  if (!inv) return null;
  let out = '';
  for (const ch of String(str)) {
    let cp = ch.codePointAt(0);
    if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD;   // lone surrogate
    if (cp <= 0x7F) { out += String.fromCharCode(cp); continue; }
    const b = inv.get(cp);
    out += (b !== undefined) ? String.fromCharCode(b) : ('&#' + cp + ';');
  }
  return out;
}

// Map a canonical WHATWG encoding name (from getEncoding) to the decoder we
// actually implement: UTF-8 / UTF-16, x-user-defined (arithmetic), or any of the
// WHATWG single-byte tables (windows-1252/125x, ISO-8859-*, KOI8-*, macintosh,
// x-mac-cyrillic, IBM866, windows-874 — all stateless byte→codepoint lookups,
// NOT the legacy MULTIBYTE CJK tables we leave out). NOTE: WHATWG has no separate
// latin1/iso-8859-1 encoding; those labels canonicalize to windows-1252 (so
// 0x80–0x9F decode to cp1252 punctuation, matching real browsers). The remaining
// multibyte encodings (Shift_JIS/EUC/Big5/gb18030/iso-2022-jp) get a correct
// *label* but degrade to the UTF-8 byte path.
function decodeStrategy(name) {
  switch (name) {
    case 'UTF-16LE':       return 'utf-16le';
    case 'UTF-16BE':       return 'utf-16be';
    case 'x-user-defined': return 'x-user-defined';
    default:               return SINGLE_BYTE_INDEXES[name] ? 'single-byte' : 'utf-8';
  }
}

const EMPTY_BYTES = new Uint8Array(0);

// Copy the bytes of `input` (BufferSource) into a fresh Uint8Array. A copy is
// required by the spec so a buffer mutated after the call can't change the
// result; it also makes the "buffer detached during options conversion" case
// safe — constructing a view over a detached buffer throws, which we swallow to
// an empty input (matching the spec's "the bytes have already been read").
function toUint8Copy(input) {
  // Non-object inputs (number, string, …) aren't BufferSources — decode to
  // nothing rather than letting `new Uint8Array(5)` mint 5 zero bytes.
  if (input == null || typeof input !== 'object') return EMPTY_BYTES;
  try {
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength).slice();
    }
    // An ArrayBuffer or SharedArrayBuffer. Don't rely on `instanceof`: the WPT
    // harness mints its SharedArrayBuffer from WebAssembly.Memory, whose
    // constructor identity needn't match the global SharedArrayBuffer. Wrapping
    // in a view copies either, and throws (→ empty) for a detached buffer.
    return new Uint8Array(input).slice();
  } catch (_) {
    return EMPTY_BYTES;
  }
}

// Faithful WHATWG TextDecoder: a stateful UTF-8 / UTF-16 decoder plus the
// stateless single-byte (all WHATWG single-byte index tables) and x-user-defined
// decoders, driven through the spec "decode" algorithm. The decoder object
// carries its partial-sequence state across `decode(..., {stream: true})` calls;
// a final non-streaming `decode()` flushes any pending bytes to U+FFFD (or throws
// under the fatal flag). BOM removal happens on the decoded U+FEFF code point in
// the serialize step — which is what makes a BOM split across stream chunks (or a
// sticky/repeated BOM) come out right. The legacy MULTIBYTE CJK tables
// (Shift_JIS/EUC/Big5/gb18030/iso-2022-jp) are out of scope; see decodeStrategy.
export class TextDecoder {
  constructor(label, options) {
    // WHATWG "get an encoding": an omitted label defaults to utf-8; an explicit
    // `null` stringifies to "null" (invalid). `getEncoding` returns the canonical
    // name or null. The TextDecoder ctor rejects an unknown label AND the
    // "replacement" encoding with a RangeError (the latter is a security rule:
    // replacement is only reachable via the decode side, not this constructor).
    const name = getEncoding(label === undefined ? 'utf-8' : String(label));
    if (!name || name === 'replacement') {
      throw new RangeError("Failed to construct 'TextDecoder': The encoding label provided ('" + label + "') is invalid.");
    }
    this.encoding    = name.toLowerCase();   // IDL `encoding` is the lowercased canonical name
    this._dec        = decodeStrategy(name);
    this._sbTable    = this._dec === 'single-byte' ? SINGLE_BYTE_INDEXES[name] : null;
    this.fatal       = !!(options && options.fatal);
    this.ignoreBOM   = !!(options && options.ignoreBOM);
    // Only UTF-8 / UTF-16 strip a leading BOM (constant for the instance).
    this._bomEnc     = this._dec === 'utf-8' || this._dec === 'utf-16le' || this._dec === 'utf-16be';
    this._doNotFlush = false;
    this._bomSeen    = false;
    this._resetDecoder();
  }

  _resetUtf8() {
    // codepoint accumulator, bytes still needed/seen, and the current
    // continuation-byte boundary that catches overlongs / encoded surrogates.
    this._cp = 0; this._need = 0; this._seen = 0; this._lo = 0x80; this._hi = 0xBF;
  }

  _resetDecoder() {
    this._resetUtf8();
    // UTF-16 decoder state (a buffered lead byte and a pending lead surrogate).
    this._leadByte = -1; this._leadSurr = -1;
  }

  // Append one decoded code point to `out` (an array of string pieces),
  // performing the spec serialize step's one-time BOM removal: the first
  // U+FEFF of the whole output stream is dropped for UTF-8 / UTF-16 unless
  // ignoreBOM. A replacement char counts as that first item too, so a BOM that
  // follows it is no longer stripped.
  _emit(out, cp) {
    if (this._bomEnc && !this._bomSeen) {
      this._bomSeen = true;
      if (!this.ignoreBOM && cp === 0xFEFF) return;
    }
    out.push(cp > 0xFFFF
      ? String.fromCharCode(0xD800 + ((cp - 0x10000) >> 10), 0xDC00 + ((cp - 0x10000) & 0x3FF))
      : String.fromCharCode(cp));
  }

  _err(out) {
    if (this.fatal) {
      throw new TypeError('The encoded data was not valid for encoding ' + this.encoding + '.');
    }
    this._emit(out, 0xFFFD);
  }

  decode(input, options) {
    // Read `stream` first: per spec the option conversion happens before the
    // bytes are read, and a getter on `options` may detach `input`'s buffer.
    const stream = !!(options && options.stream);
    if (!this._doNotFlush) { this._resetDecoder(); this._bomSeen = false; }
    this._doNotFlush = stream;

    const bytes = toUint8Copy(input);
    const flush = !stream;
    const out   = [];
    try {
      switch (this._dec) {
        case 'utf-16le':       this._utf16(out, bytes, true,  flush); break;
        case 'utf-16be':       this._utf16(out, bytes, false, flush); break;
        case 'single-byte':    this._singleByte(out, bytes);          break;
        case 'x-user-defined': this._xUserDefined(out, bytes);        break;
        default:               this._utf8(out, bytes, flush);         break;
      }
    } catch (e) {
      // A fatal-flag error aborts this decode. Reset so the decoder stays
      // reusable and a `_doNotFlush` left true by this call can't carry partial
      // state into a later stream decode (the spec resets on the next
      // non-streaming decode anyway).
      this._resetDecoder(); this._bomSeen = false; this._doNotFlush = false;
      throw e;
    }
    return out.join('');
  }

  // WHATWG UTF-8 decoder. Tracks bytes-needed/seen plus a per-sequence lower /
  // upper continuation boundary (0xE0→lo 0xA0, 0xED→hi 0x9F, 0xF0→lo 0x90,
  // 0xF4→hi 0x8F) so overlong encodings, encoded surrogates and >U+10FFFF are
  // rejected without a separate range check. An invalid continuation byte is
  // *not* consumed: it's left to be reprocessed as a fresh lead byte (the
  // "prepend" / restore step) — this is why e.g. `F0 41 42` → "�AB".
  _utf8(out, bytes, flush) {
    const n = bytes.length;
    let i = 0;
    for (;;) {
      if (i >= n) {
        if (flush && this._need !== 0) {
          this._resetUtf8();
          this._err(out);
        }
        return;
      }
      const b = bytes[i];
      if (this._need === 0) {
        if (b <= 0x7F) { this._emit(out, b); i++; }
        else if (b >= 0xC2 && b <= 0xDF) { this._need = 1; this._cp = b & 0x1F; i++; }
        else if (b >= 0xE0 && b <= 0xEF) {
          if (b === 0xE0) this._lo = 0xA0;
          else if (b === 0xED) this._hi = 0x9F;
          this._need = 2; this._cp = b & 0x0F; i++;
        } else if (b >= 0xF0 && b <= 0xF4) {
          if (b === 0xF0) this._lo = 0x90;
          else if (b === 0xF4) this._hi = 0x8F;
          this._need = 3; this._cp = b & 0x07; i++;
        } else { this._err(out); i++; }   // 0x80–0xC1, 0xF5–0xFF: invalid lead
      } else if (b < this._lo || b > this._hi) {
        // Invalid continuation: reset and emit error, then reprocess `b`.
        this._resetUtf8();
        this._err(out);
      } else {
        this._lo = 0x80; this._hi = 0xBF;
        this._cp = (this._cp << 6) | (b & 0x3F);
        this._seen++; i++;
        if (this._seen === this._need) {
          this._emit(out, this._cp);
          this._cp = 0; this._need = 0; this._seen = 0;
        }
      }
    }
  }

  // WHATWG shared UTF-16 decoder. Buffers a lead byte to form 16-bit code units,
  // pairs a lead surrogate with a following trail. An unmatched lead surrogate
  // emits an error and the following code unit is reprocessed as fresh (handled
  // by falling through with `cu` already assembled). A lone trail is an error.
  _utf16(out, bytes, le, flush) {
    const n = bytes.length;
    let i = 0;
    for (;;) {
      if (i >= n) {
        if (flush && (this._leadByte >= 0 || this._leadSurr >= 0)) {
          this._leadByte = -1; this._leadSurr = -1;
          this._err(out);
        }
        return;
      }
      const b = bytes[i++];
      if (this._leadByte < 0) { this._leadByte = b; continue; }
      const cu = le ? (b << 8) | this._leadByte : (this._leadByte << 8) | b;
      this._leadByte = -1;
      if (this._leadSurr >= 0) {
        const ls = this._leadSurr; this._leadSurr = -1;
        if (cu >= 0xDC00 && cu <= 0xDFFF) {
          this._emit(out, 0x10000 + ((ls - 0xD800) << 10) + (cu - 0xDC00));
          continue;
        }
        this._err(out);   // unmatched lead surrogate; fall through to reprocess cu
      }
      if (cu >= 0xD800 && cu <= 0xDBFF) { this._leadSurr = cu; continue; }
      if (cu >= 0xDC00 && cu <= 0xDFFF) { this._err(out); continue; }
      this._emit(out, cu);
    }
  }

  // WHATWG single-byte decoder (windows-1252/125x, ISO-8859-*, KOI8-*, macintosh,
  // x-mac-cyrillic, IBM866, windows-874 — incl. the iso-8859-1 / ascii decode
  // target windows-1252): 0x00–0x7F is identity; 0x80–0xFF maps through the index
  // table; a null slot is an error (U+FFFD, or throw under the fatal flag).
  // Stateless, so chunks split across stream calls need no carry.
  _singleByte(out, bytes) {
    const table = this._sbTable;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b < 0x80) { this._emit(out, b); continue; }
      const cp = table[b - 0x80];
      if (cp == null) this._err(out);
      else this._emit(out, cp);
    }
  }

  // x-user-defined: 0x00–0x7F identity, 0x80–0xFF → U+F780–U+F7FF (arithmetic, no
  // table). Never errors. The legacy "read bytes as a JS string" decoder.
  _xUserDefined(out, bytes) {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      this._emit(out, b < 0x80 ? b : 0xF780 + b - 0x80);
    }
  }
}

// Single-byte ENCODER (code point → byte) — the reverse of SINGLE_BYTE_INDEXES,
// for URL query "percent-encode after encoding" in a non-UTF-8 document (an
// anchor's query is encoded with the document's encoding; the fragment stays
// UTF-8). Built lazily + cached per encoding. Returns null for an encoding we
// don't model as single-byte (UTF-* / legacy MULTIBYTE) so the caller falls back
// to UTF-8 (those URL-encoding subtests stay out of scope). The returned encoder
// maps ASCII (< 0x80) to itself, a high code point via the reverse table, and an
// unencodable code point to null (the caller emits a numeric character reference).
const SINGLE_BYTE_ENCODERS = {};
globalThis.__csimSingleByteEncoder = function (label) {
  const name  = getEncoding(label, false) || label;
  const table = SINGLE_BYTE_INDEXES[name];
  if (!table) return null;
  let rev = SINGLE_BYTE_ENCODERS[name];
  if (!rev) {
    rev = new Map();
    for (let i = 0; i < table.length; i++) {
      const cp = table[i];
      if (cp != null && !rev.has(cp)) rev.set(cp, 0x80 + i);
    }
    SINGLE_BYTE_ENCODERS[name] = rev;
  }
  return function (cp) { return cp < 0x80 ? cp : (rev.has(cp) ? rev.get(cp) : null); };
};

globalThis.btoa        = btoa;
globalThis.atob        = atob;
globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;
