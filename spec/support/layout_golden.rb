# frozen_string_literal: true
require 'digest'
require 'json'

# The layout a shape is held to once the JS layout (the oracle) is gone: what the page's own geometry API answers —
# every element's border box and its client rects — recorded in a golden file and compared on every run.
#
# A golden is RECORDED (`CSIM_LAYOUT_GOLDEN=record`) only where the shape's own parity check passes: the caller's block
# runs it first, and the Rust walk is held to the oracle too, so a recorded answer is one the Rust walk, the JS walk and
# the oracle all agreed on — or one listed for a measurement against Chrome where the Rust walk alone differs. That is
# what the parity specs held these shapes to, and the golden keeps holding them to it after the reference is deleted. Where an
# answer is KNOWN to differ from Chrome the spec says so beside it with Chrome's figure (`expect_shared_gap`); a golden
# is a regression guard, not a claim of conformance.
#
# One file per spec file (`spec/fixtures/layout_golden/<spec>.json`), keyed by the body's digest, the body kept beside
# its boxes so a diff reads as a page.
module LayoutGolden
  RECORD = ENV['CSIM_LAYOUT_GOLDEN'] == 'record'
  DIR = File.expand_path('../fixtures/layout_golden', __dir__)
  # Every element in tree order, `body` and below: its tag, its border box and its client rects (an inline box's
  # fragments; a block's one rect is its box, and is left out).
  SNAPSHOT_JS = <<~JS
    (() => {
      const r4 = (r) => [r.x, r.y, r.width, r.height];
      return [document.body, ...document.body.querySelectorAll('*')].map((e) => {
        const box = e.getBoundingClientRect(), rects = [...e.getClientRects()];
        const one = rects.length === 1 && rects[0].x === box.x && rects[0].y === box.y && rects[0].width === box.width && rects[0].height === box.height;
        return one ? [e.localName, r4(box)] : [e.localName, r4(box), rects.map(r4)];
      });
    })()
  JS
  TOLERANCE = 0.01

  @files = {}
  @dirty = {}
  @divergent = []
  class << self
    attr_reader :divergent

    def file(spec_path)
      path = File.join(DIR, "#{File.basename(spec_path, '.rb')}.json")
      @files[path] ||= File.exist?(path) ? JSON.parse(File.read(path)) : {}
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
      return if @divergent.empty?

      File.write(File.expand_path('../../tmp/layout_golden_divergent.json', __dir__), JSON.pretty_generate(@divergent))
    end

    def near?(got, want)
      return (got - want).abs <= TOLERANCE if got.is_a?(Numeric) && want.is_a?(Numeric)
      return got == want unless got.is_a?(Array) && want.is_a?(Array)

      got.size == want.size && got.zip(want).all? {|g, w| near?(g, w) }
    end
  end

  # `body` laid out on the example group's own `page` (or `app`, a variant of it `variant` names in the key), held to its
  # golden — or, recording, checked by the block (the shape's parity) and then recorded.
  def expect_layout_golden(body, app: page(body), variant: nil)
    path, store = LayoutGolden.file(RSpec.current_example.metadata[:file_path])
    key = Digest::SHA256.hexdigest([body, variant].compact.join("\0"))[0, 16]
    session = simulated_session(app)
    session.visit '/'
    got = session.evaluate_script(SNAPSHOT_JS)
    if RECORD
      # …and the answer recorded is the RUST walk's, the one production lays out with: it took the page, and it agrees
      # with the oracle box for box and fragment for fragment.
      yield if block_given?
      expect(session.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}'), "#{body}: the Rust walk declined"
      # (Where it does NOT agree, the Rust answer is still the one recorded — it is the one production gives — and the
      # shape is listed for a measurement against Chrome: `tmp/layout_golden_divergent.json`.)
      rust = session.evaluate_script('globalThis.__csimLayoutShadowRun(null, {rust: true})')
      unless rust['ok'] && rust['mismatches'].to_i.zero? && rust['fragMismatches'].to_i.zero?
        LayoutGolden.divergent << {'spec' => path, 'body' => body, 'sample' => rust.slice('sample', 'fragSample')}
      end
      LayoutGolden.record(path, key, {'body' => body, 'variant' => variant, 'boxes' => got}.compact)
    else
      want = store[key]
      expect(want).not_to be_nil, "#{body}: no golden — record it with CSIM_LAYOUT_GOLDEN=record"
      bad = got.each_index.reject {|i| LayoutGolden.near?(got[i], want['boxes'][i]) }
      expect(got.size == want['boxes'].size && bad.empty?).to(
        be(true),
        "#{body}: layout moved from its golden:\n" + bad.first(5).map {|i| "  got  #{got[i].inspect}\n  want #{want['boxes'][i].inspect}" }.join("\n")
      )
    end
  end
end

RSpec.configure do |c|
  c.include LayoutGolden
  c.after(:suite) { LayoutGolden.flush }
end
