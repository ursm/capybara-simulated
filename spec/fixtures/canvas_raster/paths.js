(function () {
  function cv(w, h) { var c = new OffscreenCanvas(w, h); return [c, c.getContext('2d')]; }
  function px(ctx, w, h) { return Array.from(ctx.getImageData(0, 0, w, h).data).filter(function (_, i) { return i % 4 === 3; }); }
  var out = {};
  var a = cv(12, 12); a[1].fill(new Path2D('M1 1 h8 a3 3 0 0 1 0 6 Q5 11 1 9 T1 3 c0 -1 .5-2 2-2 z m2 2 l3 0 0 3 z')); out.svg = px(a[1], 12, 12);
  var b = cv(12, 12); b[1].lineWidth = 2; b[1].beginPath(); b[1].moveTo(1, 1); b[1].arcTo(10, 1, 10, 10, 4); b[1].lineTo(10, 10);
  b[1].lineCap = 'round'; b[1].stroke(); out.arcTo = px(b[1], 12, 12);
  var c = cv(12, 12); c[1].roundRect(10, 10, -8, -6, [3, {x: 1, y: 2}]); c[1].rect(3, 5, 4, 2); c[1].fill(); out.roundRect = px(c[1], 12, 12);
  var d = cv(12, 12); d[1].translate(6, 6); d[1].scale(2, 1); d[1].rotate(0.3); d[1].beginPath(); d[1].ellipse(0, 0, 2, 1.5, 0.4, 0.2, 5, true);
  d[1].lineJoin = 'bevel'; d[1].lineWidth = 1.5; d[1].setLineDash([2, 1, 0.5]); d[1].lineDashOffset = 0.7; d[1].stroke(); out.ellipse = px(d[1], 12, 12);
  var e = cv(12, 12); var p = new Path2D(); p.moveTo(2, 2); p.bezierCurveTo(10, 0, 0, 12, 10, 10); p.lineTo(2, 10);
  var q = new Path2D(); q.addPath(p, {a: 0.5, d: 0.5, e: 3, f: 1}); e[1].lineWidth = 1; e[1].miterLimit = 2; e[1].stroke(q); e[1].fill(p, 'evenodd'); out.addPath = px(e[1], 12, 12);
  var f = cv(12, 12); f[1].lineWidth = 3; f[1].beginPath(); f[1].moveTo(2, 2); f[1].lineTo(9, 2); f[1].lineTo(9, 9); f[1].closePath();
  var hits = [];
  for (var y = 0; y < 12; y += 1.5) for (var x = 0; x < 12; x += 1.5) hits.push(+f[1].isPointInPath(x, y), +f[1].isPointInStroke(x, y), +f[1].isPointInPath(x, y, 'evenodd'));
  out.hits = hits;
  return JSON.stringify(out);
})()
