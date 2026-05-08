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
        # Don't reuse old slots — when the QuickJS VM is rebooted in
        # the middle of a `form.submit()` Ruby callback (because the
        # navigated-to page has top-level let/const/class declarations
        # that taint the global lexical env), the OLD VM resumes with
        # stale wrappers whose `__h` integers were assigned to nodes
        # on the prior page. Clearing the slots and reusing the
        # integers would silently rebind those wrappers to whatever
        # NEW node happens to land at the same index — Redmine's
        # MyPage `add_block` then re-fires `form.submit()` on a
        # neighbouring form via the OLD VM's stale ancestor wrapper
        # and 422's the second POST.
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

      # Number of slots ever allocated (live or filled with nil).
      def size = @nodes.size

      def lookup(handle)
        @nodes[handle]
      end
    end
  end
end
