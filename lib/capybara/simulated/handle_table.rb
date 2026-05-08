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

      # Nil out old slots instead of clearing — an OLD VM that's still
      # walking a dispatch path can resume after a mid-handler
      # navigation (boot_vm leaves its stack suspended at a __dom
      # call), and reusing low integers would silently rebind its
      # stale wrappers to unrelated NEW-page nodes.
      def reset!(document)
        @nodes.fill(nil)
        @reverse.clear
        @nodes[0] = document
        @reverse[document.object_id] = 0
      end

      def track(node)
        return nil if node.nil?
        @reverse[node.object_id] ||= begin
          @nodes << node
          @nodes.size - 1
        end
      end

      # DOMPurify aliases Element-prototype methods and re-invokes them
      # via `.call(sandboxDoc, ...)`; when the receiver has no `__h`,
      # the handle arg arrives as undefined. Treat non-Integers as a
      # miss so the caller falls back to `@document` instead of
      # blowing up on `Array#[]`.
      def lookup(handle)
        @nodes[handle] if handle.is_a?(Integer)
      end
    end
  end
end
