# A `Capybara::Session.new(:simulated, app)` built inside an example owns a V8 isolate, and nothing
# tears it down: Capybara only resets the sessions IT pools, so a manually constructed one lives
# until the process exits. Measured: 30 such sessions cost 737 MB (~25 MB each); disposing them
# brings the same 30 to 39 MB.
#
# That is why CI died. The suite builds hundreds of them through per-assertion helpers, the whole
# run peaked at ~24 GB, and the 16 GB runner killed the job — while every local gate passed, because
# it was run as two processes rather than the one `bundle exec rspec` CI uses.
#
# Prefer these over `Capybara::Session.new(:simulated, …)` in any spec that builds its own session;
# the sessions Capybara pools (the DSL / shared-spec suites) are untouched.
module SimulatedSessionTeardown
  # A session disposed when the example ends. `mode` names the registered driver, so a spec with its
  # own `Capybara.register_driver` (a fixed viewport, a custom user agent) is covered too.
  def simulated_session(app, mode: :simulated)
    session = Capybara::Session.new(mode, app)
    (@__simulated_sessions ||= []) << session
    session
  end

  # A helper that only needs a VALUE out of a throwaway session can hand it back immediately
  # instead of waiting for the example to end.
  def with_simulated_session(app, mode: :simulated)
    session = Capybara::Session.new(mode, app)
    begin
      result = yield session
      declines = rust_declines(session)
      raise rust_decline_message([declines]) if declines && !RSpec.current_example.metadata[:rust_declines]

      result
    ensure
      dispose_simulated_session(session)
    end
  end

  # What the Rust walk declined on the session's page and in every frame under it, by reason — or nil. A page it declines
  # is laid out as its root alone, which a spec reading a box at the root would never notice, so every session a spec
  # built is asked at its end (an example that declines on purpose says so: `rust_declines: true`).
  RUST_DECLINES_JS = <<~JS
    (() => {
      const all = {};
      const visit = (win) => {
        const stats = win.__csimNativeLayoutStats ? win.__csimNativeLayoutStats().rustFellBack : {};
        for (const [reason, n] of Object.entries(stats)) all[reason] = (all[reason] || 0) + n;
        for (const id of win.__csimChildRealmIds || []) {
          const child = globalThis.RustyRacer.contextGlobal(id);
          if (child) visit(child);
        }
      };
      visit(globalThis);
      return JSON.stringify(all);
    })()
  JS
  def rust_declines(session)
    return unless session.instance_variable_defined?(:@driver)

    declined = session.driver.browser.evaluate_script(RUST_DECLINES_JS)
    declined == '{}' ? nil : declined
  rescue StandardError => e
    # (…a session the example already closed cannot answer; one that cannot for another reason says so)
    warn "[spec] asking a session for the Rust walk's declines failed: #{e.class}: #{e.message}" unless e.message.include?('disposed')
    nil
  end

  def rust_decline_message(declines)
    "the Rust walk declined a page, which is then laid out as its root alone: #{declines.join('; ')}"
  end

  # A spec that builds a DRIVER directly (no session) leaks the same isolate; register it so the
  # example's teardown reaches it.
  def simulated_driver(app, **opts)
    driver = Capybara::Simulated::Driver.new(app, **opts)
    (@__simulated_drivers ||= []) << driver
    driver
  end

  def dispose_simulated_session(session)
    # `Capybara::Session#driver` is LAZY and building one builds a V8 runtime eagerly, so a session
    # that was registered and then never used (an example that skipped before its first `visit`)
    # must not be given an isolate here purely so it can be disposed.
    return unless session.instance_variable_defined?(:@driver)
    driver = session.instance_variable_get(:@driver)
    return unless driver.respond_to?(:dispose)
    driver.dispose
  rescue StandardError => e
    # Never swallow silently: `Driver#dispose` marks itself disposed and deregisters BEFORE tearing
    # down (it must not be stepped mid-teardown), so a failure here leaves an isolate alive with no
    # second chance at it. That is the leak this file exists to close, so it has to be visible.
    warn "[spec] disposing a simulated session failed: #{e.class}: #{e.message}"
  end
end

RSpec.configure do |config|
  config.include SimulatedSessionTeardown

  config.after do
    sessions = @__simulated_sessions || []
    drivers  = @__simulated_drivers  || []
    @__simulated_sessions = nil
    @__simulated_drivers  = nil
    declines = sessions.filter_map {|session| rust_declines(session) }
    sessions.each do |session|
      dispose_simulated_session(session)
    end
    drivers.each do |driver|
      driver.dispose
    rescue StandardError => e
      warn "[spec] disposing a simulated driver failed: #{e.class}: #{e.message}"
    end
    raise rust_decline_message(declines) unless declines.empty? || RSpec.current_example.metadata[:rust_declines]
  end
end
