// A small, safe Markdown renderer for message bodies (a GitHub-flavoured subset). Every node is built with createElement and
// textContent: no HTML is ever parsed, so `<script>` or `&lt;` in a message is shown as the characters it is.
// Supported: headings (# to ####), tables (alignment), nested and ordered lists, task lists (read-only), blockquotes, rules, `code`,
// fenced code, links (https, mailto and in-app #/ links only), bold, italic, strikethrough, and line breaks.

const el = (tag, props = {}) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'text') n.textContent = v; else n.setAttribute(k, v); }
  return n;
};
const LINK = /\(\s*((?:[^\s()]|\([^\s()]*\))+)(?:\s+"[^"]*")?\s*\)/y; // sticky, so no slice of the rest of the text per attempt
const AUTO = /https:\/\/[^\s<>"]+/iy;
const SAFE_LINK = /^(?:https:\/\/[^\s<>"]+|mailto:[^\s<>"]+|#\/[\w-]+(?:\/c\d+)?)$/i;
export const safeHref = url => SAFE_LINK.test(url);
const PUNCT = /[!-/:-@[-`{-~]/;
const isSpace = c => c === undefined || /\s/.test(c);
const isWord = c => c !== undefined && /[\p{L}\p{N}]/u.test(c);

// ---- Inline: scans left to right; anything that is not a complete, valid construct stays literal text.
function closer(s, from, delim, memo) { // the next unescaped `delim` after `from` that follows a non-space and (for `*`/`_`) is not part of a longer run
  if (memo.failed[delim] !== undefined && from >= memo.failed[delim]) return -1; // a search that found nothing from here finds nothing from any later point
  const at = scan(s, from, delim);
  if (at < 0) memo.failed[delim] = Math.min(memo.failed[delim] ?? Infinity, from);
  return at;
}
function scan(s, from, delim) {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '`') { const e = s.indexOf('`', i + 1); if (e > 0) { i = e; continue; } }
    if (s.startsWith(delim, i) && i > from && !isSpace(s[i - 1])) {
      const single = delim.length === 1;
      if (single && (s[i + 1] === delim || s[i - 1] === delim)) continue;
      if (delim === '_' && isWord(s[i + 1])) continue;
      return i;
    }
  }
  return -1;
}
export function inline(text, parent = document.createDocumentFragment(), depth = 0) {
  const memo = { failed: {}, tick: {}, noBracket: Infinity }; // what an earlier look-ahead already proved absent, so scanning stays linear
  let lit = '';
  const flush = () => { if (lit) { parent.append(lit); lit = ''; } };
  const s = String(text);
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '\\' && PUNCT.test(s[i + 1] ?? '')) { lit += s[i + 1]; i += 2; continue; }
    if (c === '`') {
      let n = 1; while (s[i + n] === '`') n++;
      const end = memo.tick[n] !== undefined && i + n >= memo.tick[n] ? -1 : s.indexOf('`'.repeat(n), i + n);
      if (end < 0) memo.tick[n] = Math.min(memo.tick[n] ?? Infinity, i + n);
      if (end > 0) { flush(); parent.append(el('code', { text: s.slice(i + n, end).replace(/^ (.*) $/, '$1') })); i = end + n; continue; }
      lit += '`'.repeat(n); i += n; continue;
    }
    if (c === '[' && depth < 3) {
      const close = i + 1 >= memo.noBracket ? -1 : s.indexOf(']', i + 1);
      if (close < 0) memo.noBracket = Math.min(memo.noBracket, i + 1);
      LINK.lastIndex = close + 1;
      const m = close > 0 && s[close + 1] === '(' ? LINK.exec(s) : null;
      if (m && close > i + 1) {
        flush();
        const label = s.slice(i + 1, close);
        if (safeHref(m[1])) {
          const internal = m[1].startsWith('#');
          const a = el('a', { href: m[1], ...(internal ? {} : { target: '_blank', rel: 'noopener noreferrer' }) });
          inline(label, a, 3); // no links inside links
          parent.append(a);
        } else inline(label, parent, depth + 1); // an unsafe target (javascript:, data:, http:) keeps only its text
        i = close + 1 + m[0].length; continue;
      }
    }
    if (c === 'h' && depth < 3 && /^https:\/\//i.test(s.slice(i, i + 8)) && !isWord(s[i - 1])) {
      AUTO.lastIndex = i;
      const m = AUTO.exec(s);
      const url = m[0].replace(/[.,;:!?)\]*_~]+$/, '');
      flush(); const a = el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: url }); parent.append(a); i += url.length; continue;
    }
    const delim = s.startsWith('**', i) ? '**' : s.startsWith('__', i) ? '__' : s.startsWith('~~', i) ? '~~' : c === '*' || c === '_' ? c : null;
    if (delim && depth < 6 && !isSpace(s[i + delim.length]) && !(delim[0] === '_' && isWord(s[i - 1]))) {
      const end = closer(s, i + delim.length, delim, memo);
      if (end > 0) {
        flush();
        const node = el(delim === '~~' ? 'del' : delim.length === 2 ? 'strong' : 'em');
        inline(s.slice(i + delim.length, end), node, depth + 1);
        parent.append(node); i = end + delim.length; continue;
      }
    }
    lit += c; i++;
  }
  flush();
  return parent;
}
const withBreaks = (lines, parent) => { lines.forEach((l, i) => { if (i) parent.append(el('br')); inline(l.trim(), parent); }); return parent; };

// ---- Blocks
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,4})\s+(.+?)(?:\s+#+)?\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const DELIM_ROW = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const indentOf = l => /^\s*/.exec(l)[0].replace(/\t/g, '    ').length;
function cells(line) {
  const t = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return t.split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, '|').trim());
}
export const MAX_DEPTH = 8; // quotes and lists nest this far; deeper marks are plain text, so a hostile message cannot exhaust the stack
const startsBlock = (l, next, depth) => FENCE.test(l) || HEADING.test(l) || HR.test(l) || (depth < MAX_DEPTH && (QUOTE.test(l) || (ITEM.test(l) && (!/^\s*\d/.test(l) || /^\s*1[.)]/.test(l))))) || isTable(l, next);
const isTable = (l, next) => next !== undefined && l.includes('|') && DELIM_ROW.test(next) && next.includes('-') && (next.includes('|') || cells(l).length === 1) && cells(l).length === cells(next).length;

function parseList(lines, i, parent, depth) {
  const first = ITEM.exec(lines[i]), base = indentOf(lines[i]), ordered = /\d/.test(first[2]);
  const list = el(ordered ? 'ol' : 'ul');
  if (ordered && Number(first[2].replace(/\D/g, '')) !== 1) list.setAttribute('start', String(Number(first[2].replace(/\D/g, ''))));
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || indentOf(lines[i]) > base + 1 || indentOf(lines[i]) < base || /\d/.test(m[2]) !== ordered) break;
    const li = el('li');
    let body = m[3];
    const task = /^\[( |x|X)\]\s+(.*)$/.exec(body);
    if (task) {
      body = task[2]; li.setAttribute('class', 'task');
      const box = el('input', { type: 'checkbox', disabled: '', 'aria-label': task[1] === ' ' ? 'Not done' : 'Done' });
      if (task[1] !== ' ') box.setAttribute('checked', '');
      li.append(box, ' ');
    }
    const own = [body]; i++;
    const child = [];
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        let j = i + 1; while (j < lines.length && !lines[j].trim()) j++; // one look-ahead over the whole blank run
        if (j < lines.length && indentOf(lines[j]) > base) { child.push(''); i = j; continue; }
        break;
      }
      if (indentOf(l) > base + 1 || (indentOf(l) > base && !ITEM.test(l))) { child.push(l); i++; continue; }
      break;
    }
    withBreaks(own, li);
    if (child.length) {
      const pad = child.reduce((lo, x) => (x.trim() ? Math.min(lo, indentOf(x)) : lo), Infinity);
      parseBlocks(child.map(x => x.replace(/\t/g, '    ').slice(Math.min(pad, indentOf(x)))), li, depth + 1);
    }
    list.append(li);
  }
  parent.append(list);
  return i;
}
export function parseBlocks(lines, parent, depth = 0) {
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = FENCE.exec(l))) {
      const body = []; i++;
      while (i < lines.length && !(lines[i].trim().startsWith(m[1][0].repeat(m[1].length)) && /^\s*[`~]+\s*$/.test(lines[i]))) body.push(lines[i++]);
      i++;
      const code = el('code', { text: body.join('\n') }); if (m[2]) code.setAttribute('class', `lang-${m[2].replace(/[^\w+-]/g, '')}`);
      const pre = el('pre', { tabindex: '0' }); pre.append(code); parent.append(pre); continue;
    }
    if ((m = HEADING.exec(l))) { const h = el('div', { class: `md-h md-h${m[1].length}`, role: 'heading', 'aria-level': String(m[1].length + 2) }); inline(m[2], h); parent.append(h); i++; continue; }
    if (HR.test(l)) { parent.append(el('hr')); i++; continue; }
    if (depth < MAX_DEPTH && QUOTE.test(l)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])[1]);
      const bq = el('blockquote'); parseBlocks(inner, bq, depth + 1); parent.append(bq); continue;
    }
    if (isTable(l, lines[i + 1])) {
      const head = cells(l), align = cells(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
      const table = el('table'), thead = el('thead'), tbody = el('tbody'), hr = el('tr');
      const put = (row, tag, values) => values.forEach((v, c) => { const cell = el(tag, align[c] ? { style: `text-align:${align[c]}` } : {}); if (tag === 'th') cell.setAttribute('scope', 'col'); inline(v, cell); row.append(cell); });
      put(hr, 'th', head); thead.append(hr); i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const row = cells(lines[i++]); const tr = el('tr');
        put(tr, 'td', Array.from({ length: head.length }, (_, c) => row[c] ?? '')); tbody.append(tr);
      }
      table.append(thead, tbody);
      const wrap = el('div', { class: 'md-table', tabindex: '0', role: 'region', 'aria-label': 'Table' }); wrap.append(table); parent.append(wrap); continue;
    }
    if (depth < MAX_DEPTH && ITEM.test(l)) { i = parseList(lines, i, parent, depth); continue; }
    const para = [l]; i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1], depth)) para.push(lines[i++]);
    parent.append(withBreaks(para, el('p')));
  }
}
export function markdown(text) {
  const root = el('div', { class: 'text' });
  parseBlocks(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'), root);
  return root;
}

// ---- Plain text for snippets, previews and lists: the same input with the Markdown marks taken out. No DOM.
const MAX_LINE = 2000; // snippets never need more, and it keeps every pass below cheap
const plainLine = line => {
  let t = line.slice(0, MAX_LINE)
    .replace(/```[\w+-]*/g, '').replace(/^[ \t]{0,3}#{1,6}[ \t]+/, '').replace(/^[ \t]{0,3}>[ \t]?/, '').replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`+([^`]*)`+/g, '$1').replace(/(\*\*|__|~~)(.*?)\1/g, '$2').replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=$|[\s).,;:!?])/g, '$1$2');
  if (/^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/.test(t)) return ''; // a table's delimiter row
  if (/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(t)) return ''; // a rule
  if (t.includes('|')) { const cells = t.split('|').map(c => c.trim()); if (cells[0] === '') cells.shift(); while (cells.length && cells[cells.length - 1] === '') cells.pop(); t = cells.join(' · '); }
  return t.replace(/\\([!-/:-@[-`{-~])/g, '$1').trim();
};
export const plainText = text => String(text ?? '').split('\n').map(plainLine).join('\n');
// The first line that still has words once the marks are gone.
export function firstPlainLine(text) {
  for (const raw of String(text ?? '').split('\n', 400)) { const line = plainLine(raw); if (line) return line; }
  return '';
}
