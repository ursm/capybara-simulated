# frozen_string_literal: true

module Capybara
  module Simulated
    # Two-way mapping between Nokogiri nodes and integer handles. Handles
    # are the only thing that crosses the JS bridge; the JS side never
    # sees Nokogiri objects directly. Reusing the same handle for the
    # same node is important so JS can compare element identity with
    # `===` after a round-trip.
    class HandleTable
      def initialize(document)
        @nodes   = [document]
        @reverse = {document.object_id => 0}
      end

      def reset!(document)
        @nodes.clear
        @reverse.clear
        @nodes   << document
        @reverse[document.object_id] = 0
      end

      def track(node)
        return nil if node.nil?
        @reverse[node.object_id] ||= begin
          @nodes << node
          @nodes.size - 1
        end
      end

      def lookup(handle)
        @nodes[handle]
      end
    end
  end
end
