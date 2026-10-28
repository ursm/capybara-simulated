# frozen_string_literal: true
# The gemspec's file list is globs, and a glob that matches NOTHING is silent: `ext/native_cascade/*` stayed
# in `spec.files` for months after that directory was deleted, while the extension that replaced it —
# `ext/csim_native`, the one `spec.extensions` names — was never added. The built gem then carried the
# extconf.rb (RubyGems adds `extensions` to `files` itself) and none of the Rust it builds. These assertions
# are what makes that loud.
require 'rubygems'

RSpec.describe 'the gemspec' do
  let(:root) { File.expand_path('..', __dir__) }
  let(:spec) { Dir.chdir(root) { Gem::Specification.load('capybara-simulated.gemspec') } }

  it 'ships every file it declares' do
    absent = Dir.chdir(root) { spec.files.reject {|f| File.exist?(f) } }
    expect(absent).to be_empty
  end

  # …and the other way round: a glob left behind after a rename matches nothing and says nothing.
  it 'has no pattern in its file list that matches nothing' do
    # One pattern per line, read as the first quoted string on it — a trailing comment may hold quotes of its
    # own, so `scan` over the whole block picks up prose.
    patterns = File.read(File.join(root, 'capybara-simulated.gemspec'))[/spec\.files\s*=\s*Dir\[\n(.*?)^\s*\]/m, 1]
                   .to_s.lines.filter_map {|line| line[/\A\s*'([^']+)'/, 1] }
    expect(patterns).not_to be_empty, 'the file list is no longer a Dir[] of literals — update this spec'
    empty = Dir.chdir(root) { patterns.reject {|pattern| Dir[pattern].any? } }
    expect(empty).to be_empty
  end

  # A native gem whose extconf.rb ships without the crate it builds fails at install, not at build.
  it 'ships the crate each extension builds' do
    spec.extensions.each do |extconf|
      dir = File.dirname(extconf)
      expect(spec.files).to include(extconf)
      expect(spec.files).to include("#{dir}/Cargo.toml"), "#{dir}/Cargo.toml is not in spec.files"
      expect(spec.files.grep(%r{^#{Regexp.escape(dir)}/src/.*\.rs$})).not_to be_empty, "#{dir}/src/*.rs is not in spec.files"
    end
  end

  # …and every file that crate compiles in: an `include_str!` / `include_bytes!` target missing from the gem fails the
  # source install's build, as `ua.css` did.
  it 'ships every file the crate includes' do
    included = Dir.chdir(root) do
      spec.files.grep(/\.rs\z/).flat_map {|source|
        File.read(source).scan(/include_(?:str|bytes)!\(\s*"([^"]+)"\s*\)/).map {|(path)| File.join(File.dirname(source), path) }
      }
    end
    expect(included).not_to be_empty
    expect(included - spec.files).to be_empty
  end
end
