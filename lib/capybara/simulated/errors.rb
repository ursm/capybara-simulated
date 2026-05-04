module Capybara
  module Simulated
    # Raised by the runtime when a Ruby caller hands back a handle id that
    # no longer maps to a live DOM node — usually because the page was
    # reloaded between the find and the action. Capybara's synchronize
    # block catches these via the driver's `invalid_element_errors`.
    class StaleElementReferenceError < StandardError; end
  end
end
