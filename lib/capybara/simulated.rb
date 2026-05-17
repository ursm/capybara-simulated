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
  end
end

Capybara.register_driver :simulated do |app|
  Capybara::Simulated::Driver.new(app, js_engine: ENV['CSIM_JS_ENGINE']&.to_sym)
end
