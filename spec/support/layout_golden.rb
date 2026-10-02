# frozen_string_literal: true
require 'digest'
require 'fileutils'
require 'io/wait'
require 'json'
require 'nokogiri'
require 'socket'
require 'tmpdir'

# The layout a shape is held to: what the page's own geometry API answers —
# every element's border box, its client rects and its used margins and padding, and every text node's line boxes —
# recorded in a golden file and compared on every run, with the Rust walk asserted to have laid the page out.
#
# A golden is RECORDED with `CSIM_LAYOUT_GOLDEN=record` (or `rerecord`, which drops what the run did not reach — run
# the whole file). The goldens first recorded were the answers the Rust walk, a JS walk and a JS layout all agreed on,
# held to them while both still existed (2026-10-02); a shape recorded since is the Rust walk's answer, and is worth
# holding against Chrome before it is recorded. Where an answer is KNOWN to differ from Chrome the spec says so beside
# it with Chrome's figure (`expect_shared_gap`); a golden is a regression guard, not a claim of conformance. What it
# cannot see is a pseudo-element's box, which no DOM API answers.
#
# One file per spec file (`spec/fixtures/layout_golden/<spec>.json`), keyed by the body's digest, the body kept beside
# its boxes so a diff reads as a page. The figures are this machine's fonts' (fontconfig's monospace), as every
# Chrome-pinned figure in these specs already is.
#
# Where Chrome's answer differs, the entry says so: `chrome` holds Chrome's snapshot of each node more than
# CHROME_TOLERANCE off the golden, by index. `CSIM_LAYOUT_GOLDEN=chrome` (script/golden_vs_chrome.rb) writes it,
# rendering every page the run compared in headless Chrome as the example's own app serves it. A layout that moves off
# its golden onto those figures is reported as a fix to re-record rather than a regression, and recording keeps the
# notes the new boxes still differ from.
module LayoutGolden
  MODE = ENV['CSIM_LAYOUT_GOLDEN']
  RECORD = %w[record rerecord].include?(MODE)
  CHROME = MODE == 'chrome'
  DIR = File.expand_path('../fixtures/layout_golden', __dir__)
  # `body` and everything under it in tree order: an element as its tag and border box, then — where it has any — its
  # client rects (an inline box's fragments; a block's one rect is its box, and is left out) and its used margins and
  # padding (the resolved values `getComputedStyle` reports); a text node as `#text` and its line boxes — none yet:
  # `Range#getClientRects` answers an empty list.
  SNAPSHOT_JS = <<~JS
    (() => {
      const r4 = (r) => [r.x, r.y, r.width, r.height];
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let n = walker.currentNode; n; n = walker.nextNode()) {
        if (n.nodeType === Node.TEXT_NODE) {
          if (!n.data.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          out.push(['#text', [...range.getClientRects()].map(r4)]);
          continue;
        }
        const box = n.getBoundingClientRect(), rects = [...n.getClientRects()];
        const entry = [n.localName, r4(box)], more = {};
        const one = rects.length === 1 && rects[0].x === box.x && rects[0].y === box.y && rects[0].width === box.width && rects[0].height === box.height;
        if (!one) more.rects = rects.map(r4);
        const cs = getComputedStyle(n);
        const edges = ['margin', 'padding'].flatMap((p) => ['top', 'right', 'bottom', 'left'].map((s) => parseFloat(cs[`${p}-${s}`]) || 0));
        if (edges.some((v) => v !== 0)) more.edges = edges;
        if (Object.keys(more).length) entry.push(more);
        out.push(entry);
      }
      return out;
    })()
  JS
  TOLERANCE = 0.01
  # Chrome's figures are in 1/64 px and its text advances are rounded its own way: within half a pixel, it agrees.
  CHROME_TOLERANCE = 0.5

  @files = {}
  @recorded = {}
  @dirty = {}
  @chrome_queue = []
  class << self
    def file(spec_path)
      path = File.join(DIR, "#{File.basename(spec_path, '.rb')}.json")
      @recorded[path] ||= File.exist?(path) ? JSON.parse(File.read(path)) : {}
      @files[path] ||= MODE == 'rerecord' ? {} : @recorded[path]
      [path, @files[path]]
    end

    # The new boxes, with the Chrome notes of the entry they replace that they still differ from (none, where the
    # page's nodes changed).
    def record(path, key, entry)
      was = @recorded[path][key]
      notes = was && was['boxes'].size == entry['boxes'].size ? was['chrome'].to_h : {}
      chrome = notes.reject {|i, box| near?(entry['boxes'][i.to_i], box, CHROME_TOLERANCE) }
      @files[path][key] = chrome.empty? ? entry : entry.merge('chrome' => chrome)
      @dirty[path] = true
    end

    # Chrome's answer — the golden with Chrome's figures in place of the nodes they note — or nil where it agrees.
    def chrome_answer(entry)
      return unless entry['chrome']

      entry['boxes'].each_with_index.map {|box, i| entry['chrome'].fetch(i.to_s, box) }
    end

    def queue_for_chrome(path, key, app)
      @chrome_queue << [path, key, app]
    end

    # Every queued page rendered in Chrome, and its entry's notes rewritten from the answer.
    def annotate_from_chrome
      pages = Queue.new
      @chrome_queue.uniq {|path, key, _| [path, key] }.each {|page| pages << page }
      pages.close
      Array.new(ChromeSnapshot::JOBS) {
        Thread.new do
          while (page = pages.pop)
            path, key, app = page
            # (…twice: under load the odd Chrome exits before the page has loaded.)
            annotate(path, key, ChromeSnapshot.take(app) || ChromeSnapshot.take(app))
          end
        end
      }.each(&:join)
      @files.each do |path, store|
        puts "#{File.basename(path)}: #{store.count {|_, entry| entry['chrome'] }} of #{store.size} goldens differ from Chrome"
      end
    end

    # A text node the golden holds no line boxes for is not compared, or every one would be noted.
    def annotate(path, key, snapshot)
      entry = @files[path][key]
      return warn("#{entry['body']}: Chrome gave no snapshot") unless snapshot

      boxes  = entry['boxes']
      chrome = snapshot.each_index.reject {|i|
        boxes[i] == ['#text', []] || near?(snapshot[i], boxes[i], CHROME_TOLERANCE)
      }.to_h {|i| [i.to_s, snapshot[i]] }
      entry.delete('chrome')
      entry['chrome'] = chrome unless chrome.empty?
      @dirty[path] = true
    end

    def flush
      @dirty.each_key do |path|
        FileUtils.mkdir_p(DIR)
        # One shape a line, so a diff names the shapes that moved.
        lines = @files[path].sort.map {|key, entry| "  #{key.to_json}: #{entry.to_json}" }
        File.write(path, "{\n#{lines.join(",\n")}\n}\n")
      end
      @dirty.clear
    end

    def near?(got, want, tolerance = TOLERANCE)
      return (got - want).abs <= tolerance if got.is_a?(Numeric) && want.is_a?(Numeric)
      return got.keys == want.keys && got.all? {|k, v| near?(v, want[k], tolerance) } if got.is_a?(Hash) && want.is_a?(Hash)
      return got == want unless got.is_a?(Array) && want.is_a?(Array)

      got.size == want.size && got.zip(want).all? {|g, w| near?(g, w, tolerance) }
    end
  end

  # A page as headless Chrome lays it out: the example's app served over HTTP (so the page's own requests — a font —
  # reach it), with a script in its head that takes SNAPSHOT_JS once the page and its fonts have loaded and leaves it in
  # the title, which `--dump-dom` carries out.
  module ChromeSnapshot
    BIN     = '/usr/bin/google-chrome-stable'
    JOBS    = 8
    TIMEOUT = 30
    SCRIPT  = "<script>addEventListener('load', () => document.fonts.ready.then(() => { document.title = JSON.stringify(#{SNAPSHOT_JS.strip}); }));</script>"

    def self.take(app)
      server = TCPServer.new('127.0.0.1', 0)
      origin = "http://127.0.0.1:#{server.addr[1]}"
      thread = Thread.new { loop { serve(server.accept, app, origin) } }
      dom = Dir.mktmpdir {|profile|
        IO.popen(
          [
            BIN,
            '--headless=new',
            '--disable-gpu',
            '--hide-scrollbars',
            '--window-size=1024,768',
            '--virtual-time-budget=5000',
            "--user-data-dir=#{profile}",
            '--dump-dom',
            "#{origin}/"
          ],
          err:    File::NULL,
          pgroup: true
        ) {|chrome|
          # The DOM arrives in one write at the end; a Chrome that never writes it is hung, and goes.
          next chrome.read if chrome.wait_readable(TIMEOUT)

          Process.kill('KILL', -chrome.pid)
          nil
        }
      }
      return unless dom

      title = Nokogiri::HTML(dom).at('title')&.text
      title && JSON.parse(title)
    ensure
      thread&.kill
      server&.close
    end

    def self.serve(socket, app, origin)
      path = socket.gets.to_s.split[1] || '/'
      nil until socket.gets.to_s.strip.empty?
      status, headers, body = app.call(Rack::MockRequest.env_for("#{origin}#{path}"))
      content = ''.b
      body.each {|chunk| content << chunk.b }
      # (…in the head, or where the parser will open one: after the doctype.)
      if headers['content-type'].to_s.start_with?('text/html')
        content.insert(content =~ /<head[^>]*>/i ? $~.end(0) : content[/\A<!doctype[^>]*>/i].to_s.size, SCRIPT)
      end
      socket.write "HTTP/1.1 #{status} OK\r\n"
      headers.each {|name, value| socket.write "#{name}: #{value}\r\n" unless name.casecmp?('content-length') }
      socket.write "content-length: #{content.bytesize}\r\nconnection: close\r\n\r\n"
      socket.write content
    rescue IOError, SystemCallError
      nil
    ensure
      socket.close
    end
  end

  # `body` laid out on the example group's own `page` (or `app`, a variant of it `variant` names in the key — a stable
  # string, as the key must be the same on every Ruby), held to its golden — or, recording, recorded. The session goes
  # as soon as the shape is read: a loop of shapes in one example otherwise keeps every page's realm alive to its end
  # (1.3 GB where one at a time is 200 MB).
  def expect_layout_golden(body, app: page(body), variant: nil)
    path, store = LayoutGolden.file(RSpec.current_example.metadata[:file_path])
    key = Digest::SHA256.hexdigest([body, variant].compact.join("\0"))[0, 16]
    with_simulated_session(app) do |session|
      session.visit '/'
      got = session.evaluate_script(SNAPSHOT_JS)
      # The answer is the RUST walk's, the one production lays out with — so it took the page.
      expect(session.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}'), "#{body}: the Rust walk declined"
      if RECORD
        LayoutGolden.record(path, key, {'body' => body, 'variant' => variant, 'boxes' => got}.compact)
      else
        entry = store[key]
        expect(entry).not_to be_nil, "#{body}: no golden — record it with CSIM_LAYOUT_GOLDEN=record"
        LayoutGolden.queue_for_chrome(path, key, app) if CHROME
        want = entry['boxes']
        bad = got.each_index.reject {|i| LayoutGolden.near?(got[i], want[i]) }
        moved = got.size != want.size || bad.any?
        chrome = LayoutGolden.chrome_answer(entry)
        # Asked FIRST: the move a fix makes would otherwise read as a regression below.
        if moved && chrome
          expect(LayoutGolden.near?(got, chrome, CHROME_TOLERANCE)).to(
            be(false),
            "#{body}: layout moved from its golden and now AGREES with Chrome — a fix, not a regression: re-record it"
          )
        end
        expect(moved).to(
          be(false),
          "#{body}: layout moved from its golden (#{got.size} nodes, #{want.size} recorded):\n" +
            bad.first(5).map {|i| "  got  #{got[i].inspect}\n  want #{want[i].inspect}" }.join("\n")
        )
      end
    end
  end
end

RSpec.configure do |c|
  c.include LayoutGolden
  c.after(:suite) do
    LayoutGolden.annotate_from_chrome if LayoutGolden::CHROME
    LayoutGolden.flush
  end
end
