// What a page believes from the capture script inside an artifact iframe. Both pages that frame an artifact (the share link's shell and the inbox) use this one
// function: the shell embeds its source (so keep it free of imports and of anything but plain ES5), and the inbox imports it. Every field is checked and clipped;
// whatever does not fit is dropped, and a message that is not a finished capture is null. The caller checks `event.source` before it gets here.
export function parseShot(data, maxImageChars) {
  var MODES = ['region', 'element', 'section', 'page'];
  function text(value, max) { return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max) : ''; }
  function num(value) { return typeof value === 'number' && isFinite(value) && Math.abs(value) < 1e7 ? value : null; }
  if (!data || typeof data !== 'object' || data.rf !== 'shot') return null;
  var note = text(data.note, 4000).trim();
  if (!note || MODES.indexOf(data.mode) < 0) return null;
  var image = null;
  if (typeof data.image === 'string' && data.image.length <= maxImageChars && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+\/]+={0,2}$/.test(data.image)) image = data.image;
  var rect = null, viewport = null, box = null;
  var r = data.rect;
  if (r && typeof r === 'object' && num(r.x) !== null && num(r.y) !== null && num(r.width) !== null && num(r.height) !== null && r.width >= 0 && r.height >= 0) rect = { x: r.x, y: r.y, width: r.width, height: r.height };
  var v = data.viewport;
  if (v && typeof v === 'object' && num(v.width) !== null && num(v.height) !== null && v.width > 0 && v.height > 0) viewport = { width: v.width, height: v.height };
  if (rect && viewport) box = [rect.x / viewport.width, rect.y / viewport.height, rect.width / viewport.width, rect.height / viewport.height].map(function (n) { return Math.round(Math.max(-2, Math.min(3, n)) * 1000) / 1000; });
  var components = [];
  if (Array.isArray(data.components)) for (var i = 0; i < data.components.length && components.length < 8; i++) { var c = text(data.components[i], 80); if (c) components.push(c); }
  var source = null, s = data.source;
  if (s && typeof s === 'object' && typeof s.file === 'string' && s.file && Number.isInteger(s.line) && s.line > 0 && s.line < 1e7) {
    source = { file: text(s.file, 300), line: s.line, column: Number.isInteger(s.column) && s.column >= 0 && s.column < 1e7 ? s.column : 0, component: text(s.component, 80) };
  }
  return { nonce: text(data.nonce, 64), note: note, mode: data.mode, image: image, rect: rect, viewport: viewport, box: box, selector: text(data.selector, 300), text: text(data.text, 200), components: components, source: source };
}
