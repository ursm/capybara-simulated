# frozen_string_literal: true

# Bench scenarios. Driver-agnostic: each `Capybara.register_driver` is wired
# in run.rb. The `BENCH_DRIVER` env var picks one. The set is sized to
# amortise per-test fixed cost (Chrome boot dominates with very few specs)
# while staying small enough to run in under a minute even on selenium.

require 'rspec'
require 'capybara'
require 'capybara/dsl'
require 'capybara/simulated'
require_relative 'app'

bench_app = Capybara::Simulated::BenchApp.new

unless Capybara::Simulated::BenchApp.fixtures_present?
  abort <<~MSG
    Hotwire fixtures not found. Run:
      bin/rake fixtures:hotwire
    (or curl Stimulus + Turbo UMD bundles into spec/fixtures/hotwire/)
  MSG
end

Capybara.app = bench_app

driver_name = (ENV['BENCH_DRIVER'] || 'rack_test').to_sym

if driver_name == :selenium
  require 'selenium-webdriver'
  Capybara.register_driver :selenium do |app|
    options = Selenium::WebDriver::Chrome::Options.new
    options.add_argument('--headless=new')
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-gpu')
    options.unhandled_prompt_behavior = 'accept'
    Capybara::Selenium::Driver.new(app, browser: :chrome, options: options)
  end
end

Capybara.default_driver = driver_name

RSpec.configure do |c|
  # reset_sessions! drops the per-driver state (Capybara::Simulated tears
  # down the QuickJS VM, selenium navigates to about:blank). /__reset
  # then snaps the in-memory bench app's `@items` / `@profile` back to
  # their starting values so each example sees the same fixtures.
  c.before do
    Capybara.reset_sessions!
    Capybara.current_session.visit('/__reset')
  end
end

include Capybara::DSL

RSpec.describe "Hotwire bench [#{driver_name}]" do
  describe 'navigation + Stimulus actions' do
    it 'visits the home page' do
      visit '/'
      expect(page).to have_css('#home', text: 'home')
    end

    it 'follows in-document links' do
      visit '/'
      click_link 'items'
      expect(page).to have_css('#items-heading', text: 'items')
    end

    it 'increments via a Stimulus action' do
      visit '/'
      find('#counter-inc').click
      find('#counter-inc').click
      find('#counter-inc').click
      expect(find('#counter-out')).to have_text('3')
    end

    it 'decrements via a Stimulus action' do
      visit '/'
      find('#counter-dec').click
      find('#counter-dec').click
      expect(find('#counter-out')).to have_text('-2')
    end

    it 'toggles a hidden panel via a Stimulus action' do
      visit '/'
      expect(page).not_to have_css('#toggle-panel', visible: true)
      find('#toggle-btn').click
      expect(page).to have_css('#toggle-panel', visible: true, text: 'hidden by default')
    end

    it 'reads input value into a sink target' do
      visit '/'
      fill_in 'echo-src', with: 'hello'
      find('#echo-btn').click
      expect(find('#echo-sink')).to have_text('hello')
    end
  end

  describe 'forms + redirects' do
    it 'creates an item via classic POST→302→GET' do
      visit '/items'
      fill_in 'new-label', with: 'durian'
      find('#new-submit').click
      expect(page).to have_css('li[data-label="durian"]')
    end

    it 'rejects an empty label and stays on the list' do
      visit '/items'
      find('#new-submit').click
      expect(page).to have_css('#items-heading')
      expect(page).not_to have_css('li[data-label=""]')
    end

    it 'saves the profile form across multiple field types' do
      visit '/profile'
      fill_in 'p-name',  with: 'Alice'
      fill_in 'p-email', with: 'alice@example.com'
      select 'pro', from: 'p-plan'
      check 'p-terms'
      find('#p-save').click
      expect(find('#saved')).to have_text('"name":"Alice"')
      expect(find('#saved')).to have_text('"plan":"pro"')
      expect(find('#saved')).to have_text('"terms":true')
    end

    it 'round-trips the select value' do
      visit '/profile'
      select 'biz', from: 'p-plan'
      find('#p-save').click
      expect(find('#p-plan').value).to eq('biz')
    end

    it 'unchecks a previously-checked box' do
      visit '/profile'
      check 'p-terms'
      find('#p-save').click
      visit '/profile'
      uncheck 'p-terms'
      find('#p-save').click
      expect(find('#saved')).to have_text('"terms":false')
    end
  end

  describe 'Turbo Frame fetch + swap' do
    it 'replaces a frame body on link click' do
      visit '/items'
      find('#edit_link_1').click
      expect(page).to have_css('#edit_form_1')
    end
  end

  describe 'Turbo Stream actions' do
    it 'appends a row from a stream response' do
      visit '/items'
      first_row_count = page.all('#items > li').size
      fill_in 'new-label', with: 'elderberry'
      find('#new-submit').click
      expect(page).to have_css('li[data-label="elderberry"]')
      expect(page.all('#items > li').size).to eq(first_row_count + 1)
    end

    it 'replaces a node from a stream response' do
      visit '/items'
      find('#inc_1').click
      expect(find('#count_1')).to have_text('1')
      find('#inc_1').click
      expect(find('#count_1')).to have_text('2')
    end

    it 'composes append + replace on the same page' do
      visit '/items'
      find('#inc_1').click
      fill_in 'new-label', with: 'fig'
      find('#new-submit').click
      expect(find('#count_1')).to have_text('1')
      expect(page).to have_css('li[data-label="fig"]')
    end
  end

  describe 'queries + matchers' do
    it 'matches by CSS selector' do
      visit '/widgets'
      expect(page.all('#planets li').map(&:text)).to eq(%w[mercury venus earth mars])
    end

    it 'matches by XPath' do
      visit '/widgets'
      expect(page).to have_xpath('//table[@id="grid"]//td[text()="3"]')
    end

    it 'matches by text content' do
      visit '/widgets'
      expect(page).to have_text('widgets')
    end

    it 'finds inside a scope' do
      visit '/widgets'
      within('#planets') do
        expect(page).to have_text('earth')
      end
    end

    it 'opens a <details> via summary click' do
      visit '/widgets'
      expect(page).not_to have_css('#d1-body', visible: true)
      find('#d1 summary').click
      expect(page).to have_css('#d1-body', visible: true)
    end
  end

  describe 'mixed flows' do
    it 'flows across all three pages' do
      visit '/'
      find('#counter-inc').click
      click_link 'items'
      fill_in 'new-label', with: 'hackberry'
      find('#new-submit').click
      click_link 'profile'
      fill_in 'p-name', with: 'Bob'
      find('#p-save').click
      expect(find('#saved')).to have_text('"name":"Bob"')
    end
  end
end
