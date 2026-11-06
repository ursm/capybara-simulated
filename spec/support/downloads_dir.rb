# frozen_string_literal: true

require 'fileutils'
require 'tmpdir'

# What a spec's navigation downloads (`Browser#downloads_directory`) goes to one temporary directory of the whole run's,
# gone as it ends, unless the spec names its own: `Capybara.save_path`, otherwise, leaves `d.bin` and `x.txt` in the
# checkout. (A file of Capybara's own suite gets a directory per example: capybara_shared.rb.)
# Config-only, as `.rspec` requires must be (spec/support/example_persistence.rb: FORK DISCIPLINE) — and removed by the
# process that made it, not by each worker forked from it.
ENV['CSIM_DOWNLOADS_DIR'] ||= begin
  dir   = Dir.mktmpdir('csim-downloads-')
  owner = Process.pid
  at_exit { FileUtils.remove_entry(dir, true) if Process.pid == owner }
  dir
end
