# frozen_string_literal: true
require 'digest'
require 'fileutils'
require 'json'

# The layout a shape is held to once the JS layout (the oracle) is gone: what the page's own geometry API answers —
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
module LayoutGolden
  MODE = ENV['CSIM_LAYOUT_GOLDEN']
  RECORD = %w[record rerecord].include?(MODE)
  DIR = File.expand_path('../fixtures/layout_golden', __dir__)
  # `body` and everything under it in tree order: an element as its tag and border box, then — where it has any — its
  # client rects (an inline box's fragments; a block's one rect is its box, and is left out) and its used margins and
  # padding (the resolved values `getComputedStyle` reports); a text node as `#text` and its line boxes.
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

  @files = {}
  @dirty = {}
  class << self
    def file(spec_path)
      path = File.join(DIR, "#{File.basename(spec_path, '.rb')}.json")
      @files[path] ||= MODE != 'rerecord' && File.exist?(path) ? JSON.parse(File.read(path)) : {}
      [path, @files[path]]
    end

    def record(path, key, entry)
      @files[path][key] = entry
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

    def near?(got, want)
      return (got - want).abs <= TOLERANCE if got.is_a?(Numeric) && want.is_a?(Numeric)
      return got.keys == want.keys && got.all? {|k, v| near?(v, want[k]) } if got.is_a?(Hash) && want.is_a?(Hash)
      return got == want unless got.is_a?(Array) && want.is_a?(Array)

      got.size == want.size && got.zip(want).all? {|g, w| near?(g, w) }
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
        want = store[key]
        expect(want).not_to be_nil, "#{body}: no golden — record it with CSIM_LAYOUT_GOLDEN=record"
        want = want['boxes']
        bad = got.each_index.reject {|i| LayoutGolden.near?(got[i], want[i]) }
        expect(got.size == want.size && bad.empty?).to(
          be(true),
          "#{body}: layout moved from its golden (#{got.size} nodes, #{want.size} recorded):\n" +
            bad.first(5).map {|i| "  got  #{got[i].inspect}\n  want #{want[i].inspect}" }.join("\n")
        )
      end
    end
  end
end

RSpec.configure do |c|
  c.include LayoutGolden
  c.after(:suite) { LayoutGolden.flush }
end
