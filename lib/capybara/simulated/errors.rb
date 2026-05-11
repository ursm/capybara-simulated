# frozen_string_literal: true

require 'capybara'

module Capybara
  module Simulated
    # Raised when an Element handle no longer refers to a node attached
    # to the document (v2: Nokogiri parent gone; v3: dropped from the
    # JS-side handle registry). Driver lists this as an
    # `invalid_element_error`, so Capybara's `synchronize` wrapper
    # catches it and reloads the cached element.
    class StaleElement < Capybara::ElementNotFound; end unless defined?(StaleElement)
  end
end
