# frozen_string_literal: true

require_relative '../support/wpt_gate'

RSpec.describe 'WPT conformance 8/8', :wpt do
  WptGate.install(self, shard: 8, shards: 8)
end
