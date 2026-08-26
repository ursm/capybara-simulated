# frozen_string_literal: true

require_relative '../support/wpt_gate'

RSpec.describe 'WPT conformance 6/8', :wpt do
  WptGate.install(self, shard: 6, shards: 8)
end
