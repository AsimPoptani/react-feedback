// The Markdown renderer for message bodies, in a DOM (happy-dom): each construct, and the attempts to get HTML or a bad link through.
import { describe, expect, it } from 'vitest';
import { firstPlainLine, markdown, plainText, safeHref } from '../inbox/markdown.js';

const render = (text: string) => markdown(text);
const html = (text: string) => render(text).innerHTML;

describe('markdown: constructs', () => {
  it('headings # to ####, at modest sizes (no h1)', () => {
    const r = render('# One\n## Two\n### Three\n#### Four\n##### five');
    expect([...r.querySelectorAll('.md-h')].map(h => h.className)).toEqual(['md-h md-h1', 'md-h md-h2', 'md-h md-h3', 'md-h md-h4']);
    expect(r.querySelector('h1')).toBeNull();
    expect(r.querySelector('.md-h')!.getAttribute('role')).toBe('heading');
    expect(r.textContent).toContain('##### five');
  });
  it('tables with alignment, inside a scrolling wrapper, padded to the header width', () => {
    const r = render('| Model | Score | Note |\n|:--|--:|:-:|\n| A | 1 | ok |\n| B | 22 |\n\nafter');
    const wrap = r.querySelector('.md-table')!;
    expect(wrap.querySelector('table')).not.toBeNull();
    expect([...wrap.querySelectorAll('th')].map(h => h.textContent)).toEqual(['Model', 'Score', 'Note']);
    expect([...wrap.querySelectorAll('th')].map(h => h.getAttribute('style'))).toEqual(['text-align:left', 'text-align:right', 'text-align:center']);
    expect(wrap.querySelectorAll('tbody tr').length).toBe(2);
    expect(wrap.querySelectorAll('tbody tr')[1]!.querySelectorAll('td').length).toBe(3);
    expect(r.textContent).not.toContain('|');
    expect(r.querySelector('p')!.textContent).toBe('after');
    expect(wrap.getAttribute('tabindex')).toBe('0'); // keyboard-scrollable on a narrow screen
  });
  it('a pipe in a line without a delimiter row stays text; escaped pipes stay in the cell', () => {
    expect(render('a | b | c').querySelector('table')).toBeNull();
    expect(render('| a |\n|---|\n| x \\| y |').querySelector('td')!.textContent).toBe('x | y');
  });
  it('bullet, ordered (with start), nested lists and task lists', () => {
    const r = render('- a\n  - a1\n  - a2\n- b\n\n3. three\n4. four\n\n- [x] done\n- [ ] todo');
    const lists = r.querySelectorAll(':scope > ul, :scope > ol');
    expect(lists.length).toBe(3);
    expect(lists[0]!.querySelectorAll('li li').length).toBe(2);
    expect(lists[1]!.tagName).toBe('OL');
    expect(lists[1]!.getAttribute('start')).toBe('3');
    const boxes = lists[2]!.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
    expect(boxes.length).toBe(2);
    expect([...boxes].map(b => b.hasAttribute('checked'))).toEqual([true, false]);
    expect([...boxes].every(b => b.hasAttribute('disabled'))).toBe(true);
    expect(lists[2]!.textContent).toContain('todo');
    expect(lists[2]!.textContent).not.toContain('[ ]');
  });
  it('blockquotes (with markup inside), rules, inline code and fenced code', () => {
    const r = render('> quoted **bold**\n> second\n\n---\n\nuse `x < y` here\n\n```js\nconst a = "<b>";\n  indented\n```\nafter');
    expect(r.querySelector('blockquote strong')!.textContent).toBe('bold');
    expect(r.querySelector('hr')).not.toBeNull();
    expect(r.querySelector('p code')!.textContent).toBe('x < y');
    const pre = r.querySelector('pre code')!;
    expect(pre.textContent).toBe('const a = "<b>";\n  indented');
    expect(pre.className).toBe('lang-js');
    expect(r.querySelector('pre b')).toBeNull();
    expect(r.lastElementChild!.textContent).toBe('after');
  });
  it('bold, italic, strikethrough, escapes and line breaks', () => {
    const r = render('**b** __b2__ *i* _i2_ ~~s~~ snake_case_word 2*3*4 \\*not\\*\nsecond line');
    expect([...r.querySelectorAll('strong')].map(n => n.textContent)).toEqual(['b', 'b2']);
    expect([...r.querySelectorAll('em')].map(n => n.textContent)).toContain('i');
    expect(r.querySelector('del')!.textContent).toBe('s');
    expect(r.textContent).toContain('snake_case_word');
    expect(r.textContent).toContain('*not*');
    expect(r.querySelectorAll('br').length).toBe(1);
  });
  it('links: https and mailto open in a new tab with rel noopener noreferrer; bare https links too; in-app links stay in the app', () => {
    const r = render('[site](https://example.com/a?b=1) [mail](mailto:a@b.co) https://x.org/p. [thread](#/20261118-100000-abcd)');
    const [site, mail, bare, inapp] = [...r.querySelectorAll('a')];
    expect(site!.getAttribute('href')).toBe('https://example.com/a?b=1');
    expect(site!.getAttribute('target')).toBe('_blank');
    expect(site!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(mail!.getAttribute('href')).toBe('mailto:a@b.co');
    expect(bare!.getAttribute('href')).toBe('https://x.org/p');
    expect(inapp!.getAttribute('target')).toBeNull();
  });
  it('nested emphasis inside a table cell, a list item and a heading', () => {
    expect(render('| **a** |\n|---|\n| `b` |').querySelector('th strong')).not.toBeNull();
    expect(render('- *x*').querySelector('li em')).not.toBeNull();
    expect(render('## *y*').querySelector('.md-h em')).not.toBeNull();
  });
  it('old messages: plain text, "- " lists, bold and code keep their meaning, and single newlines still break the line', () => {
    const r = render('Line one\nLine two\n\n- item **one**\n- item `two`\n\nsee [x](https://example.com)');
    expect(r.querySelector('p')!.innerHTML).toBe('Line one<br>Line two');
    expect(r.querySelectorAll('li').length).toBe(2);
    expect(r.querySelector('li strong')!.textContent).toBe('one');
    expect(r.querySelector('a')!.getAttribute('href')).toBe('https://example.com');
    expect(render('').childNodes.length).toBe(0);
    expect(render('2026. was a year\nstill text').querySelector('ol')).not.toBeNull(); // GFM reads this as a list too
  });
});

describe('markdown: nothing becomes HTML', () => {
  const bad = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '&lt;script&gt;alert(1)&lt;/script&gt;', '<a href="javascript:alert(1)">x</a>', '<iframe src="https://evil"></iframe>', '<style>*{display:none}</style>'];
  it.each(bad)('shows %s as text, with no element built from it', text => {
    const r = render(text);
    expect(r.querySelector('script, img, iframe, style')).toBeNull();
    for (const a of r.querySelectorAll('a')) expect(a.getAttribute('href')).toMatch(/^https:\/\/[^"<>]*$/); // only a plain https link in the text is turned into one
    expect(r.textContent).toBe(text); // an entity is not decoded, a tag is not parsed
  });
  it('javascript:, data:, vbscript: and http: link targets keep only their text', () => {
    for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'http://example.com', '//evil.example', ' javascript:alert(1)']) {
      const r = render(`[click](${url})`);
      expect(r.querySelector('a'), url).toBeNull();
      expect(r.textContent).toBe('click');
    }
    expect(safeHref('javascript:alert(1)')).toBe(false);
    expect(safeHref('https://ok.example')).toBe(true);
  });
  it('link-text injection: markup, quotes and a nested link in the text stay text and cannot break out of the anchor', () => {
    const r = render('[<img src=x onerror=alert(1)>](https://example.com) [a](https://a.example "t\\" onclick=\\"x") [[nested](https://in.example)](https://out.example)');
    expect(r.querySelector('img')).toBeNull();
    expect([...r.querySelectorAll('a')].every(a => !a.hasAttribute('onclick') && !a.querySelector('a'))).toBe(true);
    expect(r.innerHTML).not.toMatch(/<[^>]+\son(error|click)=/i);
    expect(r.querySelector('a')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });
  it('a quote in a URL cannot add an attribute', () => {
    const r = render('[x](https://example.com/"onmouseover="alert(1))');
    for (const a of r.querySelectorAll('a')) expect([...a.attributes].map(x => x.name).sort()).toEqual(['href', 'rel', 'target']);
  });
  it('code blocks and cells keep markup as text', () => {
    const r = render('```\n<script>x</script>\n```\n\n| <b>h</b> |\n|---|\n| <i>c</i> |');
    expect(r.querySelector('script, b, i')).toBeNull();
    expect(r.querySelector('pre')!.textContent).toBe('<script>x</script>');
  });
  it('pathological input stays finite and builds no element from raw text', () => {
    const start = Date.now();
    const r = render(`${'*'.repeat(500)}${'['.repeat(300)}${'`'.repeat(200)}${'_a'.repeat(300)}${'> '.repeat(40)}x`);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(r.querySelector('script')).toBeNull();
  });
});

describe('plain text for snippets', () => {
  it('strips Markdown marks', () => {
    expect(plainText('**bold** and `code` and [link](https://x.example) ~~gone~~')).toBe('bold and code and link gone');
    expect(plainText('## Heading')).toBe('Heading');
    expect(plainText('- [x] task')).toBe('task');
    expect(plainText('> quoted')).toBe('quoted');
  });
  it('turns a table into words, skipping the delimiter row', () => {
    expect(firstPlainLine('| Model | Score |\n|---|---|\n| A | 1 |')).toBe('Model · Score');
    expect(firstPlainLine('---\n\n# Title')).toBe('Title');
    expect(firstPlainLine('')).toBe('');
    expect(plainText('| a | b |\n|---|---|\n| c | d |').split('\n').filter(Boolean)).toEqual(['a · b', 'c · d']);
  });
});
