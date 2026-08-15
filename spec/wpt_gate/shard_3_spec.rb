# frozen_string_literal: true

require_relative '../support/wpt_gate'

RSpec.describe 'WPT conformance (dom/) 3/8', :wpt do
  WptGate.install(self, shard: 3, shards: 8)
end
