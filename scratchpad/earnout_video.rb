require 'yaml'
IN = 'spec/support/wpt_expected_failures.yml'
OUT = 'spec/support/wpt_out_of_scope.yml'
infile = YAML.safe_load_file(IN)
outfile = YAML.safe_load_file(OUT)

REASON = 'video-frame RGB requires the video decoder\'s specific YUV->RGB colorspace pipeline; for a colorspace=unknown fixture ffmpeg\'s output differs from the reference browser\'s (Chrome libvpx+Skia) by more than the test\'s 3-unit tolerance. Verified: the stored YUV decodes to [255,0,0]/[254,0,0] under BT.601/ffmpeg vs the Chrome-specific expected [247,37,0]; other browsers diverge too. A media-decoder/colorspace detail, not a driver gap (rule 1).'

targets = [
  'html/canvas/element/manual/imagebitmap/createImageBitmap-drawImage.html',
  'html/canvas/element/manual/imagebitmap/createImageBitmap-flipY.html',
  'html/canvas/element/manual/imagebitmap/canvas-createImageBitmap-video-resize.html'
]

moved = 0
targets.each do |file|
  subs = Array(infile[file]).select {|s| s =~ /HTMLVideoElement|\bvideo\b/i }
  next if subs.empty?
  outfile[file] ||= []
  subs.each do |name|
    next if outfile[file].any? {|e| e['name'] == name }
    outfile[file] << {'name' => name, 'reason' => REASON}
    moved += 1
  end
end

# Write with Psych, sorted keys for stability (regen will re-canonicalize anyway).
File.write(OUT, outfile.sort.to_h.to_yaml)
puts "added #{moved} video-pixel entries to out_of_scope across #{targets.size} files"
