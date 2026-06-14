# Which JS engine will `Capybara::Session.new(:simulated, …)` auto-select?
# Several features are V8 (rusty_racer) only — per-frame realms (within_frame),
# the catchable heap-limit OOM backstop, and the native promise-reject channel
# — so the specs that exercise them gate on this to skip cleanly under QuickJS.
# Mirrors `Browser#detect_js_engine`'s CSIM_JS_ENGINE override / auto-detect.
module CsimEngine
  module_function

  def v8?
    engine = ENV['CSIM_JS_ENGINE'].to_s
    engine.empty? ? Gem.loaded_specs.key?('rusty_racer') : engine == 'v8'
  end
end
