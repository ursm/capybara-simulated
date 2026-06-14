require 'capybara/simulated'
require_relative 'support/js_engine'

# `within_frame` / `switch_to_frame`: the block's finds + actions route into
# the iframe's own V8 realm (a real nested browsing context). This mirrors
# Capybara's upstream frame fixtures (within_frames.erb + frame_*.erb) so the
# behaviour is exercised directly; the upstream shared specs run the same
# scenarios through capybara_shared_spec once `:frames` is un-skipped.
RSpec.describe 'within_frame / switch_to_frame' do
  before do
    # Per-frame realms are a V8 (rusty_racer) feature; QuickJS keeps a
    # same-realm fallback we can't route DOM ops into.
    skip 'within_frame needs the V8 engine' unless CsimEngine.v8?
  end

  let(:app) {
    lambda do |env|
      page =
        case env['PATH_INFO']
        when '/frame_one'
          <<~HTML
            <!doctype html><html><head><title>frame one</title></head>
            <body><div id="divInFrameOne">This is the text of divInFrameOne</div>
            <input id="fieldInFrameOne" type="text">
            <button id="btnInFrameOne" onclick="document.getElementById('divInFrameOne').textContent = 'clicked'">go</button>
            <a id="frameLink" href="/frame_page2">go to page 2</a>
            <form id="frameForm" action="/frame_form_target" method="post">
              <input type="text" name="q" value="hi">
              <button type="submit">submit</button>
            </form>
            </body></html>
          HTML
        when '/frame_page2'
          <<~HTML
            <!doctype html><html><head><title>frame page 2</title></head>
            <body><div id="divOnPage2">second frame page</div></body></html>
          HTML
        when '/frame_form_target'
          q = Rack::Request.new(env).params['q']
          <<~HTML
            <!doctype html><html><head><title>posted</title></head>
            <body><div id="posted">posted q=#{q}</div></body></html>
          HTML
        when '/frame_two'
          <<~HTML
            <!doctype html><html><head><title>frame two</title></head>
            <body><div id="divInFrameTwo">This is the text of divInFrameTwo</div></body></html>
          HTML
        when '/frame_parent'
          <<~HTML
            <!doctype html><html><head><title>parent frame</title></head>
            <body id="parentBody"><iframe src="/frame_one" id="childFrame"></iframe></body></html>
          HTML
        else
          <<~HTML
            <!doctype html><html><head><title>main</title></head>
            <body>
              <div id="divInMainWindow">This is the text for divInMainWindow</div>
              <iframe src="/frame_one" id="frameOne" name="my frame one"></iframe>
              <iframe src="/frame_two" id="frameTwo"></iframe>
              <iframe src="/frame_parent" id="parentFrame"></iframe>
            </body></html>
          HTML
        end
      [200, {'content-type' => 'text/html'}, [page]]
    end
  }
  let(:session) { Capybara::Session.new(:simulated, app) }
  before { session.visit('/') }

  it 'finds content inside a frame by id locator' do
    session.within_frame('frameOne') do
      expect(session.find(:css, '#divInFrameOne').text).to eq('This is the text of divInFrameOne')
    end
  end

  it 'finds content inside a frame given the element' do
    frame = session.find(:css, '#frameTwo')
    session.within_frame(frame) do
      expect(session.find(:css, '#divInFrameTwo').text).to eq('This is the text of divInFrameTwo')
    end
  end

  it 'restores the main document after the block' do
    session.within_frame('frameOne') do
      expect(session).to have_css('#divInFrameOne')
      expect(session).to have_no_css('#divInMainWindow')
    end
    expect(session.find(:css, '#divInMainWindow').text).to eq('This is the text for divInMainWindow')
  end

  it 'switches by name and back to :top' do
    session.switch_to_frame(session.find(:frame, 'frameOne'))
    expect(session.find(:css, '#divInFrameOne').text).to eq('This is the text of divInFrameOne')
    session.switch_to_frame(:top)
    expect(session.find(:css, '#divInMainWindow')).to be_truthy
  end

  it 'drives interactions inside a frame (fill_in + click)' do
    session.within_frame('frameOne') do
      session.fill_in('fieldInFrameOne', with: 'hello')
      expect(session.find(:css, '#fieldInFrameOne').value).to eq('hello')
      session.click_button('go')
      expect(session).to have_css('#divInFrameOne', text: 'clicked')
    end
  end

  it 'navigates the frame (not the top page) when a self-targeted link is clicked' do
    session.within_frame('frameOne') do
      session.click_link('go to page 2')
      expect(session).to have_css('#divOnPage2', text: 'second frame page')
      expect(session.driver.frame_url).to end_with('/frame_page2')
    end
    # The top page is unchanged.
    expect(session.current_url).to end_with('/')
    expect(session.find(:css, '#divInMainWindow')).to be_truthy
  end

  it 'submits a form inside the frame and shows the frame response' do
    session.within_frame('frameOne') do
      session.find(:css, '#frameForm input[name=q]').set('howdy')
      session.click_button('submit')
      expect(session).to have_css('#posted', text: 'posted q=howdy')
    end
    expect(session.current_url).to end_with('/')
  end

  it 'keeps the frame navigable after a frame navigation' do
    session.within_frame('frameOne') do
      session.click_link('go to page 2')
      expect(session).to have_css('#divOnPage2')
    end
    # Re-entering the frame sees the navigated document.
    session.within_frame('frameOne') do
      expect(session).to have_css('#divOnPage2')
    end
  end

  it 'switches into nested frames' do
    session.within_frame('parentFrame') do
      expect(session).to have_css('iframe#childFrame')
      session.within_frame('childFrame') do
        expect(session.find(:css, '#divInFrameOne').text).to eq('This is the text of divInFrameOne')
      end
      expect(session).to have_css('body#parentBody')
    end
    expect(session.find(:css, '#divInMainWindow')).to be_truthy
  end
end
