# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A form submits in its submission character encoding — `accept-charset`, else its document's encoding (HTML "picking
# an encoding for the form") — whichever path carries it: a top-level navigation the host encodes, or a named frame
# the page encodes. A character the encoding cannot encode is written `&#N;`, and a `_charset_` control names it.
RSpec.describe 'Form submission encoding' do
  def sjis(text) = text.encode('Shift_JIS').b

  def app(received, form)
    page = sjis(<<~HTML)
      <!DOCTYPE html><meta charset="shift_jis">
      #{form}
      <iframe name="f"></iframe>
    HTML
    lambda {|env|
      req = Rack::Request.new(env)
      if req.path == '/'
        [200, {'content-type' => 'text/html'}, [page]]
      else
        received << {path: req.path, query: env['QUERY_STRING'], type: env['CONTENT_TYPE'], body: (req.body&.read || '').b}
        [200, {'content-type' => 'text/html'}, ['<p>ok</p>']]
      end
    }
  end

  def fields = '<input name="名" value="あ&#128512;"><input type="hidden" name="_charset_"><button>go</button>'

  it 'encodes a GET query in the document encoding, top-level and into a frame' do
    received = []
    s = simulated_session(app(received, %(<form action="/top">#{fields}</form><form action="/frame" target="f">#{fields}</form>)))
    s.visit '/'
    s.all('button')[1].click
    s.all('button')[0].click
    expect(received.map { _1[:query] }).to eq(['%96%BC=%82%A0%26%23128512%3B&_charset_=Shift_JIS'] * 2)
  end

  it 'encodes urlencoded, text/plain and multipart bodies, the multipart name escaped' do
    received = []
    form = %(<form method="post" action="/u">#{fields}</form>) +
           %(<form method="post" action="/t" enctype="text/plain">#{fields}</form>) +
           %(<form method="post" action="/m" enctype="multipart/form-data"><input name='a"b' value="x">#{fields}</form>)
    s = simulated_session(app(received, form))
    3.times do |i|
      s.visit '/'
      s.all('button')[i].click
    end
    urlencoded, plain, multipart = received
    expect(urlencoded[:body]).to eq('%96%BC=%82%A0%26%23128512%3B&_charset_=Shift_JIS')
    expect([plain[:type], plain[:body]]).to eq(['text/plain', "\x96\xBC=\x82\xA0&#128512;\r\n_charset_=Shift_JIS\r\n".b])
    expect(multipart[:body]).to include(%(name="a%22b").b, %(name="\x96\xBC"\r\n\r\n\x82\xA0&#128512;).b)
  end

  it 'posts a legacy multipart body into a frame with the boundary it was written with' do
    received = []
    s = simulated_session(app(received, %(<form method="post" action="/m" target="f" enctype="multipart/form-data">#{fields}</form>)))
    s.visit '/'
    s.click_button 'go'
    boundary = received.first[:type][/boundary=(.+)/, 1]
    expect(received.first[:body]).to start_with("--#{boundary}\r\n".b)
  end

  it 'submits to the action attribute, whatever a control named `action` makes of the IDL attribute' do
    received = []
    form = %(<form method="post" action="/top"><input name="action" value="x"><button>top</button></form>) +
           %(<form method="post" action="/frame" target="f"><input name="action" value="y"><button>frame</button></form>)
    s = simulated_session(app(received, form))
    s.visit '/'
    s.click_button 'top'
    s.visit '/'
    s.click_button 'frame'
    expect(received.map { _1[:path] }).to eq(%w[/top /frame])
  end

  it "escapes a multipart filename's newlines without normalizing them, and submits `replacement` as UTF-8" do
    received = []
    form = %(<form method="post" action="/m" enctype="multipart/form-data" accept-charset="iso-2022-kr">) +
           %(<input type="file" name="f"><input type="hidden" name="_charset_"><button>go</button></form>)
    s = simulated_session(app(received, form))
    s.visit '/'
    s.execute_script(<<~'JS')
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'a\nb\r.txt'));
      document.querySelector('input[type=file]').files = dt.files;
    JS
    s.click_button 'go'
    expect(received.first[:body]).to include('filename="a%0Ab%0D.txt"'.b, %(name="_charset_"\r\n\r\nUTF-8).b)
  end
end
