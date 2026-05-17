# frozen_string_literal: true

require 'capybara'

module Capybara
  module Simulated
    # Raised when an Element handle no longer refers to a node attached
    # to the document. Driver lists this as an `invalid_element_error`,
    # so Capybara's `synchronize` wrapper catches it and reloads the
    # cached element.
    class StaleElement < Capybara::ElementNotFound; end
  end
end
