# frozen_string_literal: true

require 'capybara'
require 'capybara/simulated/version'
require 'capybara/simulated/driver'

module Capybara
  module Simulated
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
  Capybara::Simulated.next_driver_viewport   = nil
  Capybara::Simulated.next_driver_user_agent = nil
  Capybara::Simulated::Driver.new(app, viewport: vp, user_agent: ua)
end

# Capybara raises what the app raised at `visit`, `refresh`, `reset!` and a failed `synchronize`, all by
# `Session#raise_server_error!`, which asks its server — none here: `needs_server?` is false — so the driver, which stands in
# for that server (`Driver#app_raised`), is asked too. As Capybara has it: `server_errors` and `raise_server_errors` the
# session's to say, the errors let go of either way, and its cause Capybara's own words.
Capybara::Session.prepend(Module.new {
  def raise_server_error!
    super
    return unless @driver.respond_to?(:take_app_errors) && (errors = @driver.take_app_errors) && config.raise_server_errors

    error = errors.each_value.find {|e| config.server_errors.any? {|kind| e.is_a?(kind) } } or return
    begin
      raise Capybara::CapybaraError, 'Your application server raised an error - It has been raised in your test code because Capybara.raise_server_errors == true'
    rescue Capybara::CapybaraError => capy_error # rubocop:disable Naming/RescuedExceptionsVariableName
      raise error, cause: capy_error
    end
  end
})
