# frozen_string_literal: true

require_relative '../support/capybara_shared'

# Described as plain 'Simulated' (not shard-tagged) so example
# full-descriptions stay identical to the former monolithic file — the
# DESCRIPTION_SKIPS prefixes and any -e filters depend on them.
RSpec.describe Capybara::Session, 'Simulated', capybara_skip: CapybaraShared::SKIPPED_TESTS do
  CapybaraShared.install(self, shard: 4, shards: 4)
end
