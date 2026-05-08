require_relative 'lib/capybara/simulated/version'

Gem::Specification.new do |spec|
  spec.name        = 'capybara-simulated'
  spec.version     = Capybara::Simulated::VERSION
  spec.authors     = ['Keita Urashima']
  spec.email       = ['ursm@ursm.jp']
  spec.summary     = 'Lightweight Capybara driver powered by Nokogiri + QuickJS'
  spec.description = 'A Capybara driver that runs JavaScript in a long-lived QuickJS context against a Nokogiri-backed DOM, sitting between rack-test and full headless browsers.'
  spec.homepage    = 'https://github.com/ursm/capybara-simulated'
  spec.license     = 'MIT'

  spec.metadata = {
    'bug_tracker_uri'       => "#{spec.homepage}/issues",
    'changelog_uri'         => "#{spec.homepage}/releases",
    'rubygems_mfa_required' => 'true'
  }

  spec.required_ruby_version = '>= 3.3'

  spec.files = Dir[
    'lib/**/*.rb',
    'vendor/js/*.js',
    'README.md',
    'LICENSE'
  ]
  spec.require_paths = ['lib']

  spec.add_dependency 'capybara', '>= 3.37'
  spec.add_dependency 'nokogiri', '>= 1.18'
  spec.add_dependency 'p_css',    '>= 0.1.7'
  spec.add_dependency 'quickjs',  '>= 0.15'
  spec.add_dependency 'rack',     '>= 2.2'
end
