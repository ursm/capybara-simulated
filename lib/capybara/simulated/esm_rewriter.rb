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

      IMPORT_NAMED_RE = %r<
        #{STMT_LEAD}\bimport\s+
        (?:
          (?<default>\w+)\s*,\s*\{(?<named>[^}]+)\}
          | (?<default>\w+)\s*,\s*\*\s+as\s+(?<ns>\w+)
          | (?<default>\w+)
          | \*\s+as\s+(?<ns>\w+)
          | \{(?<named>[^}]+)\}
        )
        \s+from\s+(?<q>['"])(?<url>[^'"]+)\k<q>\s*;?
      >mx.freeze

      IMPORT_BARE_RE = %r<
        #{STMT_LEAD}\bimport\s+(?<q>['"])(?<url>[^'"]+)\k<q>\s*;?
      >mx.freeze

      EXPORT_STAR_RE = %r<
        #{STMT_LEAD}\bexport\s+\*
        (?:\s+as\s+(?<ns>\w+))?
        \s+from\s+(?<q>['"])(?<url>[^'"]+)\k<q>\s*;?
      >mx.freeze

      EXPORT_LIST_FROM_RE = %r<
        #{STMT_LEAD}\bexport\s*\{(?<list>[^}]+)\}\s+from\s+
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

      # Returns [rewritten_source, dependency_urls]. `dependency_urls` is
      # the de-duped specifier list in appearance order so callers can
      # pre-warm `__csim_require`'s source cache before evaluating.
      def self.rewrite(source)
        deps = []
        named_appendix = []
        default_appendix = nil

        result = source.dup

        result.gsub!(IMPORT_NAMED_RE) do
          m = ::Regexp.last_match
          deps << m[:url]
          parts = []
          parts << "const #{m[:default]} = __csim_require(#{m[:url].to_json}).default;" if m[:default]
          parts << "const #{m[:ns]} = __csim_require(#{m[:url].to_json});"               if m[:ns]
          if m[:named]
            mapped = parse_binding_list(m[:named]).map {|orig, local|
              orig == local ? local : "#{orig}: #{local}"
            }.join(', ')
            parts << "const { #{mapped} } = __csim_require(#{m[:url].to_json});"
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
          deps << m[:url]
          if m[:ns]
            "__exports.#{m[:ns]} = __csim_require(#{m[:url].to_json});\n"
          else
            tmp = "__csim_ns_#{deps.length}"
            "var #{tmp} = __csim_require(#{m[:url].to_json}); " \
              "for (var __k in #{tmp}) { if (__k !== 'default') __exports[__k] = #{tmp}[__k]; }\n"
          end
        end

        result.gsub!(EXPORT_LIST_FROM_RE) do
          m = ::Regexp.last_match
          deps << m[:url]
          tmp = "__csim_ns_#{deps.length}"
          assignments = parse_binding_list(m[:list]).map {|orig, local|
            "__exports.#{local} = #{tmp}.#{orig};"
          }.join(' ')
          "var #{tmp} = __csim_require(#{m[:url].to_json}); #{assignments}\n"
        end

        result.gsub!(EXPORT_LIST_RE) do
          m = ::Regexp.last_match
          parse_binding_list(m[:list]).map {|orig, local|
            "__exports.#{local} = #{orig};"
          }.join(' ') + "\n"
        end

        # `export default class Foo {…}` / `export default function Foo(…)` —
        # rewrite to a plain declaration and queue `__exports.default = Foo`
        # to fire after the rest of the body runs. Anonymous variants get
        # a synthetic local so the appendix can refer to them.
        result.gsub!(EXPORT_DEFAULT_DECL_RE) do
          m = ::Regexp.last_match
          name = m[:name] || (m[:kind].include?('function') ? '__csim_default_fn' : '__csim_default_class')
          default_appendix = "__exports.default = #{name};"
          named = m[:name] ? '' : " #{name}"
          "#{m[:kind]}#{named}"
        end

        result.gsub!(EXPORT_DEFAULT_EXPR_RE) do
          '__exports.default = '
        end

        # `export const X = …` / `export class X …` / `export function X …`:
        # strip the leading `export` and queue `__exports.X = X` for the
        # appendix. The appendix runs at the end of the module body, by
        # which point class / function declarations are bound.
        result.gsub!(EXPORT_DECL_RE) do
          m = ::Regexp.last_match
          named_appendix << m[:name]
          "#{m[:kind]} #{m[:name]}"
        end

        appendix = []
        named_appendix.uniq.each {|n| appendix << "__exports.#{n} = #{n};" }
        appendix << default_appendix if default_appendix

        result += "\n#{appendix.join("\n")}\n" unless appendix.empty?
        [result, deps.uniq]
      end
    end
  end
end
