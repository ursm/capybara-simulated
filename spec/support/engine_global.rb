# frozen_string_literal: true

# A realm's engine ops are no property of its global (engine.js): a page — an app's — reaches none of them. A spec that
# reads the engine's own state off a page (`__dom.nidOf(node)`, `__dom.layoutMeasureCounts()`) has the realms made under
# `EngineGlobal.within { … }` name them `__dom` (dom.rs `ENGINE_GLOBAL`, read as each realm is made); an example or a
# group tagged `engine_global: true` runs whole under it.
module EngineGlobal
  def self.within
    Capybara::Simulated::Native.engine_global = true
    yield
  ensure
    Capybara::Simulated::Native.engine_global = false
  end
end

# (…a script outside RSpec — the perf gate's regen — the block alone)
if defined?(RSpec)
  RSpec.configure do |config|
    config.around(:each, :engine_global) do |example|
      EngineGlobal.within { example.run }
    end
  end
end
