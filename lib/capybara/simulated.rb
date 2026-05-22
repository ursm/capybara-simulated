# frozen_string_literal: true

require 'capybara'
require 'capybara/simulated/version'
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

    # Host wrappers (csim_rspec / csim_minitest) set this just before
    # `driven_by :simulated` to seed the next constructed driver's
    # viewport — used when the host's spec asked for a mobile-shape
    # driver (Discourse's `mobile: true`-tagged describes). Read-and-
    # cleared by the register_driver block.
    class << self
      attr_accessor :next_driver_viewport
    end
  end
end

Capybara.register_driver :simulated do |app|
  vp = Capybara::Simulated.next_driver_viewport
  Capybara::Simulated.next_driver_viewport = nil
  Capybara::Simulated::Driver.new(app, js_engine: ENV['CSIM_JS_ENGINE']&.to_sym, viewport: vp)
end
