require 'bundler/gem_tasks'

# The committed per-file runtime log that balances `parallel_rspec
# --group-by runtime` groups (CI and local). Refresh it when spec files are
# added / split or when group balance drifts — exact numbers don't matter,
# only their proportions.
desc 'Run the suite in parallel and refresh spec/support/parallel_runtime_rspec.log'
task :parallel_runtime_log do
  # Don't run while another parallel_rspec is up: the rm_f + per-worker
  # truncation races a concurrent launch's one-shot read of the log.
  log = 'spec/support/parallel_runtime_rspec.log'
  rm_f log
  sh 'bundle exec parallel_rspec spec ' \
     "-o '--format progress --format ParallelTests::RSpec::RuntimeLogger --out #{log}'"
  # Normalize the raw logger output:
  #   - RuntimeLogger inherits BaseTextFormatter's :message hook, so RSpec's
  #     run-options banner lands in the file — keep spec-file entries only.
  #   - capybara_shared_spec's top-level group is created inside the capybara
  #     gem (SpecHelper.run_specs), so its runtime is attributed to the gem's
  #     absolute path — rewrite it to the spec file the grouping matches.
  #   - Sum duplicate keys: parallel_tests' reader is last-line-wins, never sums.
  times = Hash.new(0.0)
  File.readlines(log).each do |line|
    path, sep, seconds = line.strip.rpartition(':')
    next if sep.empty?
    path = 'spec/capybara_shared_spec.rb' if path.match?(%r{/capybara-[^/]+/lib/capybara/spec/spec_helper\.rb\z})
    next unless path.start_with?('spec/')
    times[path] += seconds.to_f
  end
  File.write(log, times.sort.map {|path, seconds| "#{path}:#{seconds}\n" }.join)
end
