# frozen_string_literal: true

# A realm's engine ops are no property of its global (engine.js): a page — an app's — reaches none of them. A spec that
# reads the engine's own state off a page (`__dom.nidOf(node)`, `__dom.layoutMeasureCounts()`) has the realms made under
# `EngineGlobal.within { … }` name them `__dom`, and their `RustyRacer` rusty_racer's whole host namespace besides
# (`contextGlobal`: dom.rs `ENGINE_GLOBAL`, read as each realm is made, engine.js `__csimTakeEngine`); an example or a
# group tagged `engine_global: true` runs whole under it.
module EngineGlobal
  @depth = 0

  # (…nested — a tagged example running the WPT runner — off again only as the outermost ends)
  def self.within
    @depth += 1
    Capybara::Simulated::Native.engine_global = true
    yield
  ensure
    @depth -= 1
    Capybara::Simulated::Native.engine_global = false if @depth.zero?
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
