(function () {
  function cv(w, h, opts) { var c = new OffscreenCanvas(w, h); return [c, c.getContext('2d', opts)]; }
  function px(ctx, w, h) { return Array.from(ctx.getImageData(0, 0, w, h).data); }
  var out = {};
  var a = cv(4, 1); a[1].fillStyle = 'red'; a[1].fillRect(0.5, 0, 1.5, 1); out.aaBox = px(a[1], 4, 1);
  var b = cv(6, 6); b[1].fillStyle = 'rgba(0, 0, 255, 0.5)'; b[1].beginPath(); b[1].moveTo(0, 0); b[1].lineTo(6, 1); b[1].lineTo(2, 6); b[1].closePath();
  b[1].moveTo(1, 1); b[1].lineTo(4, 2); b[1].lineTo(2, 4); b[1].closePath(); b[1].fill('evenodd'); out.evenOdd = px(b[1], 6, 6);
  var c = cv(5, 1); var g = c[1].createLinearGradient(0, 0, 5, 0); g.addColorStop(0, 'red'); g.addColorStop(1, 'rgba(0, 0, 255, 0.5)');
  c[1].fillStyle = g; c[1].fillRect(0, 0, 5, 1); out.linear = px(c[1], 5, 1);
  var d = cv(5, 5); var rg = d[1].createRadialGradient(2.5, 2.5, 0, 2.5, 2.5, 3); rg.addColorStop(0, 'white'); rg.addColorStop(1, 'black');
  d[1].fillStyle = rg; d[1].fillRect(0, 0, 5, 5); out.radial = px(d[1], 5, 5);
  var e = cv(5, 5); var cg = e[1].createConicGradient(0.3, 2.5, 2.5); cg.addColorStop(0, 'lime'); cg.addColorStop(1, 'blue');
  e[1].fillStyle = cg; e[1].fillRect(0, 0, 5, 5); out.conic = px(e[1], 5, 5);
  var t = cv(2, 2); t[1].fillStyle = 'red'; t[1].fillRect(0, 0, 1, 1); t[1].fillStyle = 'lime'; t[1].fillRect(1, 1, 1, 1);
  var f = cv(5, 3); var pat = f[1].createPattern(t[0], 'repeat-x'); pat.setTransform({a: 1, b: 0, c: 0, d: 1, e: 1, f: 0});
  f[1].fillStyle = pat; f[1].fillRect(0, 0, 5, 3); out.pattern = px(f[1], 5, 3);
  var h = cv(5, 5); h[1].drawImage(t[0], 0, 0, 5, 5); out.smooth = px(h[1], 5, 5);
  var h2 = cv(5, 5); h2[1].imageSmoothingEnabled = false; h2[1].rotate(0.2); h2[1].drawImage(t[0], 1, 0, 4, 4); out.nearest = px(h2[1], 5, 5);
  var s = cv(8, 8); s[1].shadowColor = 'rgba(0, 128, 0, 0.8)'; s[1].shadowBlur = 3; s[1].shadowOffsetX = 2; s[1].shadowOffsetY = 1;
  s[1].fillStyle = 'red'; s[1].fillRect(1, 1, 3, 3); out.shadow = px(s[1], 8, 8);
  var ops = ['multiply', 'xor', 'screen', 'soft-light', 'destination-out', 'lighter', 'copy', 'source-in', 'color-burn', 'hue'];
  out.ops = ops.map(function (op) {
    var k = cv(3, 1); k[1].fillStyle = 'rgba(200, 100, 50, 0.7)'; k[1].fillRect(0, 0, 2, 1);
    k[1].globalCompositeOperation = op; k[1].globalAlpha = 0.6; k[1].fillStyle = 'rgba(20, 220, 140, 0.9)'; k[1].fillRect(1, 0, 1.5, 1);
    return px(k[1], 3, 1);
  });
  var cl = cv(6, 6); cl[1].beginPath(); cl[1].arc(3, 3, 2.2, 0, 7); cl[1].clip(); cl[1].fillStyle = 'black'; cl[1].fillRect(0, 0, 6, 6);
  out.clip = px(cl[1], 6, 6);
  var cr = cv(4, 1); cr[1].fillStyle = 'black'; cr[1].fillRect(0, 0, 4, 1); cr[1].clearRect(0.25, 0, 2, 1); out.clear = px(cr[1], 4, 1);
  var st = cv(8, 8); st[1].lineWidth = 2; st[1].setLineDash([3, 1]); st[1].lineJoin = 'round'; st[1].strokeStyle = 'navy';
  st[1].strokeRect(1.5, 1.5, 5, 4); out.stroke = px(st[1], 8, 8);
  var p3 = cv(2, 1, {colorSpace: 'display-p3'}); p3[1].fillStyle = 'rgb(255, 0, 0)'; p3[1].fillRect(0, 0, 1, 1);
  p3[1].putImageData(new ImageData(new Uint8ClampedArray([0, 255, 0, 255]), 1, 1), 1, 0);
  out.p3 = [px(p3[1], 2, 1), Array.from(p3[1].getImageData(0, 0, 2, 1, {colorSpace: 'srgb'}).data)];
  return JSON.stringify(out);
})()
