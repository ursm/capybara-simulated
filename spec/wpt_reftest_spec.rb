# frozen_string_literal: true

require 'spec_helper'
require_relative 'support/wpt_runner'

# The two grammars the WPT gate reads out of a REFTEST's head to know what it is
# judged against. The gate runs every vendored reftest, so a broken RENDERING shows
# up there immediately — but a broken PARSE does not: a missed `fuzzy` bound turns an
# accepted rendering into a recorded failure, and a missed `<link>` turns a real test
# into a silently unmeasured one. Both land in an allowlist looking like a driver gap.
RSpec.describe WptRunner do
  describe '.parse_reftest_refs' do
    it 'resolves a relative reference against the test\'s own directory' do
      expect(described_class.parse_reftest_refs('<link rel=match href="foo-ref.html">', 'dom/nodes'))
        .to eq([['==', 'dom/nodes/foo-ref.html']])
    end

    it 'takes an absolute reference from the WPT root' do
      expect(described_class.parse_reftest_refs('<link rel="match" href="/css/reference/blank.html">', 'dom'))
        .to eq([['==', 'css/reference/blank.html']])
    end

    it 'reads rel=mismatch as "these must DIFFER"' do
      expect(described_class.parse_reftest_refs("<link rel='mismatch' href='x-notref.html'>", 'dom'))
        .to eq([['!=', 'dom/x-notref.html']])
    end

    # A QUERY selects what the reference draws: eight css-transforms tests point at one
    # `transform-interpolation-ref.html` and pass it `?rotate` / `?scale` / …, which the page reads
    # out of `location.search`. Resolving the href as a bare path left `File.file?` looking for a
    # name with `?rotate` glued to it, and eight tests recorded "reference not vendored" against a
    # reference that is right there.
    it 'keeps the query a reference carries' do
      expect(described_class.parse_reftest_refs('<link rel=match href="ref.html?rotate">', 'css/x'))
        .to eq([['==', 'css/x/ref.html?rotate']])
      expect(described_class.ref_path('css/x/ref.html?rotate')).to eq('css/x/ref.html')
    end

    # `about:blank` is a reference like any other — a `mismatch` against it asserts the test drew
    # something. Resolving it as a relative path produced `css/x/about:blank`.
    it 'keeps about:blank as itself' do
      expect(described_class.parse_reftest_refs('<link rel=mismatch href="about:blank">', 'css/x'))
        .to eq([['!=', 'about:blank']])
    end

    # A `<link>` inside a COMMENT is not a link. One vendored test carries its reference that way,
    # and reading it made a file WPT does not treat as a reftest into a permanently failing one.
    it 'ignores a link inside a comment' do
      head = '<!--<link rel="match" href="tutorial-ref.html">--><p>not a reftest'
      expect(described_class.parse_reftest_refs(head, 'css/x')).to eq([])
    end

    it 'keeps several references in document order — WPT passes the test if ANY holds' do
      head = '<link rel=match href=a-ref.html><link rel=match href=b-ref.html>'
      expect(described_class.parse_reftest_refs(head, 'dom')).to eq([['==', 'dom/a-ref.html'], ['==', 'dom/b-ref.html']])
    end

    it 'ignores the other <link>s a test carries' do
      head = '<link rel="author" href="mailto:nobody@example.com"><link rel=help href="https://example.com/spec">'
      expect(described_class.parse_reftest_refs(head, 'dom')).to be_empty
    end

    it 'ignores a match link with no href' do
      expect(described_class.parse_reftest_refs('<link rel=match>', 'dom')).to be_empty
    end
  end

  describe '.parse_reftest_fuzzy' do
    it 'demands pixel identity when the test declares no fuzz' do
      expect(described_class.parse_reftest_fuzzy('<title>no fuzz</title>'))
        .to eq({max_difference: [0, 0], total_pixels: [0, 0]})
    end

    it 'keeps both ends of each declared range' do
      expect(described_class.parse_reftest_fuzzy('<meta name=fuzzy content="maxDifference=0-2;totalPixels=0-100">'))
        .to eq({max_difference: [0, 2], total_pixels: [0, 100]})
    end

    it 'reads a bare bound as the degenerate range N-N, the way WPT does' do
      expect(described_class.parse_reftest_fuzzy('<meta name="fuzzy" content="maxDifference=5;totalPixels=40">'))
        .to eq({max_difference: [5, 5], total_pixels: [40, 40]})
    end

    it 'reads unnamed bounds positionally — maxDifference, then totalPixels' do
      expect(described_class.parse_reftest_fuzzy('<meta name=fuzzy content="0-5;0-245">'))
        .to eq({max_difference: [0, 5], total_pixels: [0, 245]})
    end

    it 'mixes a bare positional bound with a named one' do
      expect(described_class.parse_reftest_fuzzy('<meta name=fuzzy content="1;totalPixels=0-3900">'))
        .to eq({max_difference: [1, 1], total_pixels: [0, 3900]})
    end

    it 'takes the bounds of a reference-scoped annotation, dropping the scope' do
      head = '<meta name=fuzzy content="foo-ref.html:maxDifference=1-3;totalPixels=0-25">'
      expect(described_class.parse_reftest_fuzzy(head)).to eq({max_difference: [1, 3], total_pixels: [0, 25]})
    end
  end

  # The comparison verdict itself, which is wptrunner's `executors/base.py` formula. The escapes
  # matter: a pixel-identical rendering has to pass a test whose declared range starts above zero.
  describe '.fuzzy_equal?' do
    def fuzzy(difference, pixels) = {max_difference: difference, total_pixels: pixels}
    def diff(difference, pixels)  = {max_difference: difference, differing_pixels: pixels}

    it 'accepts an identical rendering with no fuzz declared' do
      expect(described_class.fuzzy_equal?(diff(0, 0), fuzzy([0, 0], [0, 0]))).to be(true)
    end

    it 'rejects any difference when no fuzz is declared' do
      expect(described_class.fuzzy_equal?(diff(1, 1), fuzzy([0, 0], [0, 0]))).to be(false)
    end

    it 'accepts a difference inside both declared ranges' do
      expect(described_class.fuzzy_equal?(diff(2, 90), fuzzy([0, 2], [0, 100]))).to be(true)
    end

    it 'rejects a pixel count past the declared range even when the channel difference fits' do
      expect(described_class.fuzzy_equal?(diff(2, 101), fuzzy([0, 2], [0, 100]))).to be(false)
    end

    it 'accepts an identical rendering when either declared floor is zero' do
      expect(described_class.fuzzy_equal?(diff(0, 0), fuzzy([1, 3], [0, 25]))).to be(true)
    end

    # wptrunner's own quirk, reproduced deliberately: with BOTH floors above zero neither escape
    # applies, so a rendering identical to the reference fails a test that demanded a difference.
    it 'rejects an identical rendering when both declared floors are above zero' do
      expect(described_class.fuzzy_equal?(diff(0, 0), fuzzy([1, 3], [10, 25]))).to be(false)
    end

    it 'rejects a rendering that differs by LESS than the declared floor' do
      expect(described_class.fuzzy_equal?(diff(1, 5), fuzzy([1, 3], [10, 25]))).to be(false)
    end
  end
end
