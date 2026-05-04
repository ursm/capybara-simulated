require_relative 'lib/capybara/simulated/version'

Gem::Specification.new do |spec|
  spec.name        = 'capybara-simulated'
  spec.version     = Capybara::Simulated::VERSION
  spec.authors     = ['Keita Urashima']
  spec.email       = ['ursm@ursm.jp']
  spec.summary     = 'Lightweight Capybara driver powered by V8 (mini_racer) + happy-dom'
  spec.description = 'A Capybara driver that runs JavaScript in a long-lived mini_racer V8 context against a happy-dom DOM, sitting between rack-test and full headless browsers.'
  spec.homepage    = 'https://github.com/ursm/capybara-simulated'
  spec.license     = 'MIT'

  spec.metadata = {
    'bug_tracker_uri'       => "#{spec.homepage}/issues",
    'changelog_uri'         => "#{spec.homepage}/releases",
    'rubygems_mfa_required' => 'true'
  }

  spec.required_ruby_version = '>= 3.3'

  spec.files = Dir['lib/**/*.rb', 'vendor/js/*.js', 'vendor/js/*.mjs', 'README.md', 'LICENSE']
  spec.require_paths = ['lib']

  spec.add_dependency 'capybara',   '>= 3.40'
  spec.add_dependency 'mini_racer', '>= 0.18'
  spec.add_dependency 'rack',       '>= 2.2'
end
