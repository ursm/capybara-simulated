# frozen_string_literal: true

require 'capybara'
# The rasteriser behind image decoding and the canvas surface — required HERE rather than lazily at
# each use, because a bundle without it does not merely lose canvas: an image's intrinsic size feeds
# LAYOUT, so pages with images would be laid out wrong while only warning. The gem is a hard
# dependency; what can still be missing is the libvips SYSTEM library it binds to, so name it.
begin
  require 'vips'
rescue LoadError => e
  raise LoadError, "capybara-simulated needs the libvips system library (Debian/Ubuntu " \
                   "`libvips42`, Homebrew `vips`, Gentoo `media-libs/vips`): #{e.message}"
end
require 'capybara/simulated/version'
require 'capybara/simulated/native'   # the Rust cascade accelerator (required; run `rake compile` in a dev checkout)
require 'capybara/simulated/driver'

module Capybara
  module Simulated
    # Canonical list of JS-engine identifiers. Used by:
    # - `Browser#build_runtime` to dispatch to the right Runtime class
    # - `Browser#detect_js_engine` to pick a default when neither
    #   `CSIM_JS_ENGINE` nor `js_engine:` is given (order = preference,
    #   so V8 wins ties because it's faster per-spec)
    # - vs-world's `csim_rspec.rb` / `csim_minitest.rb` to validate
    #   YAML `engine:` keys at load time
    JS_ENGINES = %i[v8 quickjs].freeze

    # Host wrappers (csim_rspec / csim_minitest) set these just before
    # `driven_by :simulated` to seed the next constructed driver's
    # viewport + user-agent — used when the host's spec asked for a
    # mobile-shape driver (Discourse's `mobile: true`-tagged
    # describes). Discourse uses BOTH viewport breakpoints AND UA
    # sniffing to pick mobile/desktop rendering, so both have to be
    # set together. Read-and-cleared by the register_driver block.
    class << self
      attr_accessor :next_driver_viewport, :next_driver_user_agent

      # Empty the process-wide HTTP cache (see `Driver#clear_http_cache`) — the
      # module-level form for a hook that runs before any session exists.
      def clear_http_cache = Browser.clear_http_cache
    end
  end
end

Capybara.register_driver :simulated do |app|
  vp = Capybara::Simulated.next_driver_viewport
  ua = Capybara::Simulated.next_driver_user_agent
  Capybara::Simulated.next_driver_viewport = nil
  Capybara::Simulated.next_driver_user_agent = nil
  Capybara::Simulated::Driver.new(app, js_engine: ENV['CSIM_JS_ENGINE']&.to_sym, viewport: vp, user_agent: ua)
end
