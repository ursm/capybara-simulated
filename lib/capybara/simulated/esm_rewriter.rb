# frozen_string_literal: true

require 'json'

module Capybara
  module Simulated
    # Rewrites ES-module source into a function body the V8 runtime can
    # eval inside `new Function('__exports', source)`. mini_racer doesn't
    # expose V8's module loader, so we synthesise the missing pieces in
    # JS land: imports become `__csim_require(url)` calls, exports become
    # property assignments on the `__exports` parameter.
    #
    # The rewrite is intentionally lexical — Browser#rewrite_module_imports
    # has already pre-resolved every specifier to an absolute URL, so
    # each `import`/`export-from` is a full URL the host can hand straight
    # to `__csim_require`.
    #
    # Coverage: every static import form, named/default/namespace exports
    # for variable/class/function declarations, re-exports, and
    # `export * from`. Dynamic `import()` and `import.meta` aren't handled
    # — Stimulus / Turbo bundles don't use them at module top-level (the
    # one place we'd see them is stimulus-loading's eager loader, which
    # passes literal specifiers Browser#load_module already resolves).
    module EsmRewriter
      # Statement-position lead. Top-level ES-module declarations sit
      # at the start of the file, or after a previous statement
      # terminator. ASI counts: an unterminated `import … from "url"`
      # ends at the line break, so a bare `\n` (or `;` / `}`) is enough
      # to put us at statement position. Minified bundles cram
      # everything onto one line and rely on the `;` / `}` cases.
      STMT_LEAD = '(?:\A|(?<=[;}\n]))[ \t]*'

      # Whitespace between `import`/`from` and the surrounding tokens is
      # optional when the adjacent token starts with a non-word character
      # (`{`, `*`, `"`, `'`). Vite/Rolldown's minified output omits it:
      # `import{t as e}from"../foo.js"`. Use `\b` to keep `importx` /
      # `xfrom` from matching while allowing zero-or-more whitespace.
      IMPORT_NAMED_RE = %r<
        #{STMT_LEAD}\bimport\b\s*
        (?:
          (?<default>\w+)\s*,\s*\{(?<named>[^}]+)\}
          | (?<default>\w+)\s*,\s*\*\s*\bas\b\s+(?<ns>\w+)
          | (?<default>\w+)
          | \*\s*\bas\b\s+(?<ns>\w+)
          | \{(?<named>[^}]+)\}
        )
        \s*\bfrom\b\s*(?<q>['"])(?<url>[^'"]+)\k<q>\s*;?
      >mx.freeze

      IMPORT_BARE_RE = %r<
        #{STMT_LEAD}\bimport\b\s*(?<q>['"])(?<url>[^'"]+)\k<q>\s*;?
      >mx.freeze

      EXPORT_STAR_RE = %r<
        #{STMT_LEAD}\bexport\b\s*\*
        (?:\s*\bas\b\s+(?<ns>\w+))?
        \s*\bfrom\b\s*(?<q>['"])(?<url>[^'"]+)\k<q>\s*;?
      >mx.freeze

      EXPORT_LIST_FROM_RE = %r<
        #{STMT_LEAD}\bexport\b\s*\{(?<list>[^}]+)\}\s*\bfrom\b\s*
        (?<q>['"])(?<url>[^'"]+)\k<q>\s*;?
      >mx.freeze

      EXPORT_LIST_RE = %r<
        #{STMT_LEAD}\bexport\s*\{(?<list>[^}]+)\}\s*;?
      >mx.freeze

      # `\w+` would match `extends` in `export default class extends Controller`,
      # so gate the optional name with a negative lookahead. The trailing
      # `\b` keeps `class` itself from matching prefixes like `classroom`.
      EXPORT_DEFAULT_DECL_RE = %r<
        #{STMT_LEAD}\bexport\s+default\s+(?<kind>class|function|async\s+function)(?:\s+(?<name>(?!extends\b)\w+))?\b
      >x.freeze

      EXPORT_DEFAULT_EXPR_RE = %r<
        #{STMT_LEAD}\bexport\s+default\s+
      >x.freeze

      EXPORT_DECL_RE = %r<
        #{STMT_LEAD}\bexport\s+(?<kind>const|let|var|function|async\s+function|class)\s+(?<name>\w+)\b
      >x.freeze

      # Dynamic `import(spec)`. mini_racer doesn't expose V8's host
      # import callback, so we redirect every dynamic-import call site
      # to `__csim_dynamicImport(...)` — a host-defined wrapper that
      # synchronously resolves via the same module cache and returns a
      # `Promise.resolve(exports)`. The literal-string vs non-literal
      # distinction goes away: any expression flows through the same
      # path.
      #
      # The negative lookbehind keeps `Foo.import(…)` /
      # `someimport(…)` from matching; the trailing `(?=\s*\()`
      # lookahead pins the keyword to its call site.
      DYNAMIC_IMPORT_RE = Regexp.new(
        %q{(?<![\w$.])\bimport(?=\s*\()},
        Regexp::EXTENDED
      ).freeze

      def self.parse_binding_list(list)
        list.split(',').map(&:strip).reject(&:empty?).map {|pair|
          if pair =~ /\A(\S+)\s+as\s+(\S+)\z/
            [::Regexp.last_match(1), ::Regexp.last_match(2)]
          else
            [pair, pair]
          end
        }
      end

      # `import.meta` is illegal syntax in a `new Function` body (it
      # requires module-mode parsing, which our `__csim_require` wrapper
      # can't provide). Replace with a plain object literal carrying the
      # module URL so common Vite-built call sites like
      # `__vite__mapDeps([...], import.meta.url)` keep their semantics.
      # `import.meta.env` is build-time-replaced by Vite, so the runtime
      # bundle never references it.
      IMPORT_META_RE = /\bimport\.meta\b/.freeze

      # Returns [rewritten_source, dependency_urls]. `dependency_urls` is
      # the de-duped specifier list in appearance order so callers can
      # pre-warm `__csim_require`'s source cache before evaluating. Pass
      # the module's own URL via `url:` to populate the inlined
      # `import.meta.url`.
      def self.rewrite(source, url: nil)
        deps = []
        named_appendix = []
        default_appendix = nil

        result = source.dup
        # Always rewrite — an empty url is better than leaving the literal
        # `import.meta`, which fails to parse outside module mode.
        result.gsub!(IMPORT_META_RE, "({url:#{(url || '').to_json}})")

        # Per-source counter for module-namespace tmp vars. Each import
        # statement gets its own `__csim_m_N` so `__csim_liveImport` can
        # close over the namespace object and re-read on each access.
        mod_seq = 0
        next_mod = ->(url) {
          deps << url
          mod_seq += 1
          "__csim_m_#{mod_seq}"
        }

        result.gsub!(IMPORT_NAMED_RE) do
          m = ::Regexp.last_match
          tmp = next_mod.call(m[:url])
          parts = ["const #{tmp} = __csim_require(#{m[:url].to_json});"]
          parts << "const #{m[:default]} = __csim_liveImport(#{tmp}, 'default');" if m[:default]
          parts << "const #{m[:ns]} = #{tmp};"                                    if m[:ns]
          if m[:named]
            parse_binding_list(m[:named]).each {|orig, local|
              parts << "const #{local} = __csim_liveImport(#{tmp}, #{orig.to_json});"
            }
          end
          parts.join("\n") + "\n"
        end

        result.gsub!(IMPORT_BARE_RE) do
          m = ::Regexp.last_match
          deps << m[:url]
          "__csim_require(#{m[:url].to_json});\n"
        end

        result.gsub!(DYNAMIC_IMPORT_RE, '__csim_dynamicImport')

        result.gsub!(EXPORT_STAR_RE) do
          m = ::Regexp.last_match
          tmp = next_mod.call(m[:url])
          if m[:ns]
            "var #{tmp} = __csim_require(#{m[:url].to_json}); " \
              "__csim_defineExport(__exports, #{m[:ns].to_json}, function () { return #{tmp}; });\n"
          else
            "var #{tmp} = __csim_require(#{m[:url].to_json}); " \
              "for (var __k in #{tmp}) (function (k) { " \
              "if (k !== 'default') __csim_defineExport(__exports, k, function () { return #{tmp}[k]; }); " \
              "})(__k);\n"
          end
        end

        result.gsub!(EXPORT_LIST_FROM_RE) do
          m = ::Regexp.last_match
          tmp = next_mod.call(m[:url])
          assignments = parse_binding_list(m[:list]).map {|orig, local|
            "__csim_defineExport(__exports, #{local.to_json}, function () { return #{tmp}.#{orig}; });"
          }.join(' ')
          "var #{tmp} = __csim_require(#{m[:url].to_json}); #{assignments}\n"
        end

        result.gsub!(EXPORT_LIST_RE) do
          m = ::Regexp.last_match
          parse_binding_list(m[:list]).map {|orig, local|
            "__csim_defineExport(__exports, #{local.to_json}, function () { return #{orig}; });"
          }.join(' ') + "\n"
        end

        # `export default class Foo {…}` / `export default function Foo(…)` —
        # rewrite to a plain declaration and queue a live-binding export
        # for `default` to fire after the rest of the body runs.
        # Anonymous variants get a synthetic local so the appendix can
        # refer to them.
        result.gsub!(EXPORT_DEFAULT_DECL_RE) do
          m = ::Regexp.last_match
          name = m[:name] || (m[:kind].include?('function') ? '__csim_default_fn' : '__csim_default_class')
          default_appendix = "__csim_defineExport(__exports, 'default', function () { return #{name}; });"
          named = m[:name] ? '' : " #{name}"
          "#{m[:kind]}#{named}"
        end

        # `export default <expr>` — assign the value eagerly to a local
        # so we can live-bind to it.
        result.gsub!(EXPORT_DEFAULT_EXPR_RE) do
          default_appendix = "__csim_defineExport(__exports, 'default', function () { return __csim_default; });"
          'var __csim_default = '
        end

        # `export const X = …` / `export class X …` / `export function X …`:
        # strip the leading `export` and queue a live-binding export for
        # X. The appendix runs at the end of the module body, by which
        # point class / function declarations are bound.
        result.gsub!(EXPORT_DECL_RE) do
          m = ::Regexp.last_match
          named_appendix << m[:name]
          "#{m[:kind]} #{m[:name]}"
        end

        appendix = []
        named_appendix.uniq.each {|n|
          appendix << "__csim_defineExport(__exports, #{n.to_json}, function () { return #{n}; });"
        }
        appendix << default_appendix if default_appendix

        result += "\n#{appendix.join("\n")}\n" unless appendix.empty?
        [result, deps.uniq]
      end
    end
  end
end
