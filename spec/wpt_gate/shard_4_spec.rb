# frozen_string_literal: true

require_relative '../support/wpt_gate'

RSpec.describe 'WPT conformance (dom/) 4/8', :wpt do
  WptGate.install(self, shard: 4, shards: 8)
end
