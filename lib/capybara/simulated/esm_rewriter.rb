# frozen_string_literal: true

require 'json'
require 'digest'

module Capybara
  module Simulated
    # Rewrites ES-module source into a function body the V8 runtime can
    # eval inside `new Function('__exports', source)`. mini_racer doesn't
    # expose V8's module loader, so we synthesise the missing pieces in
    # JS land: imports become `__csim_require(url)` calls, exports become
    # `__csim_defineExport(...)` getter registrations on the `__exports`
    # parameter.
    #
    # The rewrite is intentionally lexical — Browser#rewrite_module_imports
    # has already pre-resolved every specifier to an absolute URL, so
    # each `import`/`export-from` is a full URL the host can hand straight
    # to `__csim_require`.
    #
    # Coverage: every static import form, named/default/namespace exports
    # for variable/class/function declarations, re-exports, and
    # `export * from`. Dynamic `import()` and `import.meta` aren't handled
    # at module top-level via this rewriter — `import()` is folded into a
    # synchronous `__csim_dynamicImport(...)`, and `import.meta` is
    # replaced by an inlined `{url:"..."}` literal.
    #
    # Line-preserving: every rewrite stays on the original source line so
    # that bundler-emitted `.map` files keep working unchanged.
    # `__csim_defineExport(...)` calls land inline directly adjacent to
    # the originating declaration — there is no end-of-file appendix —
    # which means even the bundle's last line stays within the source
    # map's coverage and the `StackResolver` can decode every frame.
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

      # Process-wide cache of rewritten output keyed by
      # `(url, sha256(source))`. Each Discourse test wipes its
      # `Browser#@module_cache` (URL-keyed) to guard against stale
      # rewritten bodies when the server recomputes a same-URL module
      # against new state — but the rewrite itself is purely a function
      # of (source, url). Caching here lets identical bodies skip the
      # 9-regex-gsub pass that dominates ~6.5 % of Discourse suite wall
      # time. Bounded so a long-running process can't grow without
      # limit; LRU-ish eviction (delete-oldest-on-overflow via Hash
      # insertion order) is enough for the access pattern we see.
      CACHE_LIMIT = 4096
      @cache      = {}
      @cache_lock = Mutex.new

      def self.cache_clear
        @cache_lock.synchronize { @cache.clear }
      end

      # Returns [rewritten_source, dependency_urls]. `dependency_urls` is
      # the de-duped specifier list in appearance order so callers can
      # pre-warm `__csim_require`'s source cache before evaluating. Pass
      # the module's own URL via `url:` to populate the inlined
      # `import.meta.url`. Result is cached by (url, sha256(source)) so
      # the next caller paying the same input pays only a hash lookup.
      def self.rewrite(source, url: nil)
        key = "#{url}\x00#{Digest::SHA256.hexdigest(source)}"
        if (hit = @cache_lock.synchronize { @cache[key] })
          return hit
        end
        result = rewrite_uncached(source, url: url).freeze
        @cache_lock.synchronize {
          @cache.shift while @cache.size >= CACHE_LIMIT
          @cache[key] = result
        }
        result
      end

      def self.rewrite_uncached(source, url: nil)
        deps = []

        result = source.dup
        # Skip the regex pass when the literal isn't present —
        # `String#include?` is C-level on the full bundle string. Most
        # modules don't reference `import.meta`, so this is the common
        # path. When present, rewrite to a `{url:"..."}` literal so
        # `Vite/Rolldown`'s `import.meta.url` call sites keep working
        # inside our `new Function` wrapper (where module-mode parsing
        # isn't available).
        if result.include?('import.meta')
          result.gsub!(IMPORT_META_RE, "({url:#{(url || '').to_json}})")
        end

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
          parts.join(' ') + ' '
        end

        result.gsub!(IMPORT_BARE_RE) do
          m = ::Regexp.last_match
          deps << m[:url]
          "__csim_require(#{m[:url].to_json}); "
        end

        # Real ESM resolves `import('./x.js')` against the *importer's*
        # URL, not the page URL. Our rewriter substitutes the call site
        # with a per-module helper that closes over `__csim_module_url`
        # so the runtime has the importer's URL available without us
        # having to regex-balance parens to inject a second argument.
        if result.match?(DYNAMIC_IMPORT_RE)
          result.gsub!(DYNAMIC_IMPORT_RE, '__csim_dynamicImport_here')
          result = "var __csim_module_url = #{(url || '').to_json}; " \
            "function __csim_dynamicImport_here(s) { return __csim_dynamicImport(s, __csim_module_url); } " +
            result
        end

        result.gsub!(EXPORT_STAR_RE) do
          m = ::Regexp.last_match
          tmp = next_mod.call(m[:url])
          if m[:ns]
            "var #{tmp} = __csim_require(#{m[:url].to_json}); " \
              "__csim_defineExport(__exports, #{m[:ns].to_json}, function () { return #{tmp}; }); "
          else
            "var #{tmp} = __csim_require(#{m[:url].to_json}); " \
              "for (var __k in #{tmp}) (function (k) { " \
              "if (k !== 'default') __csim_defineExport(__exports, k, function () { return #{tmp}[k]; }); " \
              "})(__k); "
          end
        end

        result.gsub!(EXPORT_LIST_FROM_RE) do
          m = ::Regexp.last_match
          tmp = next_mod.call(m[:url])
          assignments = parse_binding_list(m[:list]).map {|orig, local|
            "__csim_defineExport(__exports, #{local.to_json}, function () { return #{tmp}.#{orig}; });"
          }.join(' ')
          "var #{tmp} = __csim_require(#{m[:url].to_json}); #{assignments} "
        end

        result.gsub!(EXPORT_LIST_RE) do
          m = ::Regexp.last_match
          parse_binding_list(m[:list]).map {|orig, local|
            "__csim_defineExport(__exports, #{local.to_json}, function () { return #{orig}; });"
          }.join(' ') + ' '
        end

        # `export default class Foo {...}` / `export default function Foo(...)`:
        # register the export *before* the declaration on the same line.
        # The getter closes over `Foo` and only reads it when an
        # importer touches the export — by then the declaration has
        # executed. Anonymous variants get a synthetic name.
        result.gsub!(EXPORT_DEFAULT_DECL_RE) do
          m = ::Regexp.last_match
          name = m[:name] || (m[:kind].include?('function') ? '__csim_default_fn' : '__csim_default_class')
          "__csim_defineExport(__exports, 'default', function () { return #{name}; }); #{m[:kind]} #{name}"
        end

        # `export default <expr>` — register first, then assign. `var`
        # is hoisted (declaration only); a cyclic import that reads the
        # export before initialisation lands sees `undefined`, matching
        # real-ESM's TDZ-ish behaviour for `var`-shaped compatibility.
        result.gsub!(EXPORT_DEFAULT_EXPR_RE) do
          "__csim_defineExport(__exports, 'default', function () { return __csim_default; }); var __csim_default = "
        end

        # `export const X = ...` / `export class X ...` /
        # `export function X ...`: register before the declaration.
        # Same closure-defers-the-read logic — `const`/`let` work
        # because the getter only fires when an importer accesses the
        # export, and by then the initialiser has run.
        result.gsub!(EXPORT_DECL_RE) do
          m = ::Regexp.last_match
          "__csim_defineExport(__exports, #{m[:name].to_json}, function () { return #{m[:name]}; }); #{m[:kind]} #{m[:name]}"
        end

        [result, deps.uniq]
      end
    end
  end
end
