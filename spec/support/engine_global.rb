# frozen_string_literal: true

# A realm's engine ops are no property of its global (engine.js), nor is its host object — rusty_racer's namespace, the
# host's procs and the steps the host calls: a page — an app's — reaches none of them. A spec that reads the engine's
# own state off a page (`__dom.nidOf(node)`, `__dom.layoutMeasureCounts()`) has the realms made under
# `EngineGlobal.within { … }` name them `__dom`, and their `RustyRacer` the namespace's functions (`contextGlobal`), the
# steps (`steps`) and the host object (`host`) besides (dom.rs `ENGINE_GLOBAL`, read as each realm is made, engine.js
# `__csimTakeEngine`); an example or a group tagged `engine_global: true` runs whole under it.
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
