# frozen_string_literal: true

# Regenerates spec/support/capybara_group_weights.yml — measured per-group
# seconds for Capybara's shared-spec registry, which capybara_shared.rb's
# weighted partition packs into shards. Needed only when the capybara gem
# version changes (the group set / their relative costs move) — the digest
# guard in the capybara_shared gate is what tells you.
#
#   CSIM_JS_ENGINE=quickjs bundle exec ruby script/regen_capybara_group_weights.rb
#
# QuickJS is the engine whose job the balance binds (it runs every group ~2x
# V8's cost with the same proportions), so record under it. The measurement
# runs the capybara_shared gate serially with rspec's JSON formatter and sums
# example run_times per registry group, matched by full-description prefix —
# deliberately independent of the current shard partition, so regenerating
# with a stale YAML is fine.
require 'json'
require 'yaml'
require 'open3'
require 'capybara/spec/spec_helper'

out, status = Open3.capture2('bundle', 'exec', 'rspec', 'spec/capybara_shared', '--format', 'json')
abort 'measurement run failed (see above)' unless status.success?

report = JSON.parse(out[/\{.*\}\z/m])
# Longest-prefix match: group names are not prefix-free ('#find' vs
# '#find_field'). Names are mostly Strings but a few registry entries use a
# Class (Capybara::Selector) — normalize to the string RSpec renders.
names = Capybara::SpecHelper.instance_variable_get(:@specs).map {|name, _, _| name.to_s }.sort_by(&:length).reverse

weights = Hash.new(0.0)
report['examples'].each do |ex|
  desc = ex['full_description'].to_s
  name = names.find {|n| desc.include?(" #{n} ") || desc.include?(" #{n}.") }
  next unless name
  weights[name] += ex['run_time'].to_f
end

path = 'spec/support/capybara_group_weights.yml'
File.write(path, <<~HEAD + weights.sort.to_h.transform_values {|v| v.round(3) }.to_yaml.sub(/\A---\n/, ''))
  # Measured seconds per Capybara shared-spec group (see
  # script/regen_capybara_group_weights.rb — regenerate on a capybara
  # upgrade). Only the PROPORTIONS matter: capybara_shared.rb greedy-packs
  # groups into shards by these weights so no shard dwarfs its siblings.
HEAD
puts "#{path}: #{weights.size} groups, #{weights.values.sum.round(1)} s total"
