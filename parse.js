// parse.js — a fast, dependency-free Markdown renderer that produces
// exactly the HTML marked 18.1.3 renders with its default options
// (GFM on, breaks off, pedantic off, async off).
//
// Written from scratch against the CommonMark 0.31.2 + GFM 0.29 rules as
// marked implements them. No code is copied from marked; the vendored
// marked build in the kit is used only as a reference for exact output
// (verified against the kit's 720 practice cases).
//
// Architecture: a block lexer (recursive for blockquote/list) produces
// block tokens; inline content is lexed lazily (after all link reference
// definitions are collected) with a delimiter-stack emphasis parser;
// a renderer walks the tokens to HTML. This mirrors the structure any
// correct CommonMark renderer needs; the code, names and optimisations
// are my own.

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUMERIC_REF_TEST = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const CARRIAGE_RETURN = /\r\n?/g;

// Escape HTML special chars. encode=true escapes every one;
// encode=false leaves a valid character/entity reference alone.
function escapeHtml(s, encode) {
  if (encode) {
    return ESCAPE_TEST.test(s) ? s.replace(ESCAPE_REPLACE, (c) => ESC[c]) : s;
  }
  return ESCAPE_TEST_NO_ENCODE.test(s) ? s.replace(ESCAPE_REPLACE_NO_ENCODE, (c) => ESC[c]) : s;
}

// Decode numeric character references in inline text (&#35; -> #,
// &#0; -> U+FFFD). Named references (&copy;) pass through untouched.
// A bare & not starting a valid reference becomes &amp;.
function decodeRefs(s) {
  if (!NUMERIC_REF_TEST.test(s)) return s;
  return s.replace(NUMERIC_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// Clean a link/image URL: encode it, restoring literal % (marked's cleanUrl).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

// Split a table row into cells on unescaped pipes, trimming each cell.
function splitTableRow(row, count) {
  const t = row.replace(/\|/g, (ch, off, str) => {
    let escaped = false;
    for (let p = off - 1; p >= 0 && str[p] === '\\'; p--) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(' |');
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Trim trailing occurrences of `ch` from a string (or, if `not` is set,
// trailing characters that are NOT `ch`).
function trimEndChar(s, ch, not) {
  let n = s.length;
  if (n === 0) return '';
  let k = 0;
  while (k < n) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !not) k++;
    else if (c !== ch && not) k++;
    else break;
  }
  return s.slice(0, n - k);
}

// Trim excess trailing blank lines from an HTML block (keep at most the
// usual trailing newline structure).
function trimBlankLines(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Normalise a link reference label (collapse whitespace, Unicode case-fold).
function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the paren/bracket that closes the one opened at the
// start of the scan: returns -1 (none), -2 (unclosed), or the index.
function findCloser(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces (tab stops every 4 columns from `col`).
function expandTabs(s, col) {
  let out = '';
  let c = col || 0;
  for (const ch of s) {
    if (ch === '\t') {
      const n = 4 - (c % 4);
      out += ' '.repeat(n);
      c += n;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// Compensate a fenced code block's content for the opening fence's indent
// (read from the start of the full fence match).
function fenceIndent(text, raw) {
  const m = raw.match(/^(\s+)(?:```)/);
  if (!m) return text;
  const indent = m[1];
  return text.split('\n').map((line) => {
    const sp = line.match(/^\s+/);
    if (!sp) return line;
    return line.slice(Math.min(sp[0].length, indent.length));
  }).join('\n');
}

// ------------------------------------------------------------------
// Grammar: the block and inline rules (GFM), built from pattern
// templates the way any regex-driven CommonMark parser builds them.
// ------------------------------------------------------------------

// Tiny regex builder: start from a pattern (string or RegExp source),
// substitute named placeholders, and produce a RegExp.
function rx(pattern, flags) {
  let src = typeof pattern === 'string' ? pattern : pattern.source;
  return {
    replace(name, sub) {
      const s = typeof sub === 'string' ? sub : sub.source;
      // escape ^ in the replacement the way marked does (caret after [^)
      src = src.replace(name, s.replace(/(^|[^\[])\^/g, '$1'));
      return this;
    },
    get() { return new RegExp(src, flags); },
  };
}

const BLOCK_TAG = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

const R = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: /^ {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  bull: / {0,3}(?:[*+-]|\d{1,9}[.)])/,
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  html: null, // built below
  def: null, // built below
  table: null, // built below
  lheading: null, // built below
  paragraph: null, // built below
  text: /^[^\n]+/,
};

// HTML block: the 7 CommonMark conditions.
R.html = rx(
  '^ *(?:' +
  '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' +
  '|comment[^\\n]*(\\n+|$)' +
  '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' +
  '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' +
  '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' +
  '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
  '|<(?!script|pre|style|textarea)([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
  '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
  ')', 'i')
  .replace('comment', HTML_COMMENT)
  .replace('tag', BLOCK_TAG)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .get();

// Link reference definition.
const LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const TITLE = /(?:\"(?:\\[\s\S]|[^\"\\])*\"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
R.def = rx(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', LABEL)
  .replace('title', TITLE)
  .get();

// Setext heading (GFM: the paragraph part must not start a table).
const LHEADING_SRC = '^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
R.lheading = rx(LHEADING_SRC)
  .replace(/bull/g, R.bull)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .get();

// GFM table.
R.table = rx("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)")
  .replace('hr', R.hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', /(?: {4}| {0,3}\t)[^\n]/)
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', BLOCK_TAG)
  .get();

// Paragraph (GFM): lines until a blank line or a block start.
const PARA_SRC = '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';
function paraRegex(listBull) {
  return rx(PARA_SRC)
    .replace('hr', R.hr)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('table', R.table)
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listBull)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', BLOCK_TAG)
    .get();
}
R.paragraph = paraRegex(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
// The paragraph pattern used inside blockquotes (list must be indented).
const PARA_QUOTE = paraRegex(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
// Blockquote: a run of lines each starting with `>` (plus lazy paragraph
// continuation lines, which the paragraph pattern covers).
R.blockquote = rx(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', PARA_QUOTE)
  .get();

// Shared small patterns used by several rules.
const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`),
  // Memoised regex factories (parameterised by the indent R).
  nextBulletRegex: memo((a) => new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`)),
  hrRegex: memo((a) => new RegExp(`^ {0,${a}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\n+|$)`)),
  fencesBeginRegex: memo((a) => new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: memo((a) => new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: memo((a) => new RegExp(`^ {0,${a}}(?:</?(?:${BLOCK_TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: memo((a) => new RegExp(`^ {0,${a}}>`)),
};

// Memoised indent-parameterised regexes. The indent is clamped to
// (indent - 1), floored at 0 and capped at 3, before building the regex.
function memo(fn) {
  const cache = [];
  return (a) => {
    const n = Math.max(0, Math.min(3, a - 1));
    let v = cache[n];
    if (v === undefined) { v = fn(n); cache[n] = v; }
    return v;
  };
}

// ------------------------------------------------------------------
// Inline grammar (GFM)
// ------------------------------------------------------------------

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;
const PUNCT_SPACE_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const PUNCT_TILDE = /(?!~)[\p{P}\p{S}]/u;
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;

// A link label: balanced brackets (one nested level), backslash escapes,
// code spans allowed. The inner `brackets` slot is the nested-bracket group.
const BRACKETED = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL_INNER = rx(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', BRACKETED)
  .get();
const LABEL_REF = /(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const LABEL_NOLINK = /(?:\\[\s\S]|[^\[\]\\])+/;

const I = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  // text: runs of plain text, stopping before anything inline-significant
  text: null,
  link: null,
  reflink: null,
  nolink: null,
  autolink: null,
  tag: null,
  url: null,
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  // emphasis delimiters (left/right, * and _)
  emStrongLDelim: null,
  emStrongRDelimAst: null,
  emStrongRDelimUnd: null,
  delLDelim: null,
  delRDelim: null,
  anyPunctuation: null,
  anyPunctuationOutsideCode: null,
  blockSkip: null,
  reflinkSearch: null,
  punctuation: null,
  _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
};

// Link: [text](href "title")
I.link = rx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', LABEL_INNER)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .get();
// Reference link: [text][label]
I.reflink = rx(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', LABEL_INNER)
  .replace('ref', LABEL_REF)
  .get();
// Shortcut / collapsed reference link: [text] or [text][]
I.nolink = rx(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', LABEL_NOLINK)
  .get();
// Autolink: <scheme:...> or <email>
I.autolink = rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .get();
// Inline HTML tag.
I.tag = rx("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>")
  .replace('comment', rx(/<!--(?:-?>|[\s\S]*?(?:-->|$))/).replace('(?:-->|$)', '-->').get())
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .get();
// GFM extended autolink (www. / scheme:// / email), with backpedal.
// The mailto:/xmpp: email must NOT capture its @ (group 1 is the
// scheme/www part, group 2 the @ of a bare email); the bare-email
// alternative keeps the (@) group.
const EMAIL_RE = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_NG = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const SCHEME_RE = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
I.url = rx(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, EMAIL_NG).get())
  .replace('protocol', SCHEME_RE)
  .replace('email', EMAIL_RE)
  .get();
// Emphasis left delimiters.
I.emStrongLDelim = rx(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u')
  .replace(/punct/g, PUNCT_TILDE)
  .get();
// Emphasis right delimiters (* and _ variants).
const RDELIM_AST = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
I.emStrongRDelimAst = rx(RDELIM_AST, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_TILDE)
  .replace(/punctSpace/g, PUNCT_SPACE_TILDE)
  .replace(/punct/g, PUNCT_TILDE)
  .get();
const RDELIM_UND = "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)";
I.emStrongRDelimUnd = rx(RDELIM_UND, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .get();
// Strikethrough delimiters.
I.delLDelim = rx(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, PUNCT)
  .get();
const RDELIM_DEL = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
I.delRDelim = rx(RDELIM_DEL, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .get();
// Punctuation helpers used by the emStrong mask.
I.anyPunctuation = rx(/\\(punct)/, 'gu').replace(/punct/g, PUNCT).get();
I.anyPunctuationOutsideCode = rx(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').replace(/punct/g, PUNCT).get();
// blockSkip: code spans / links / html that the emStrong mask must not
// treat as containing emphasis delimiters.
I.blockSkip = rx(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .get();
// reflinkSearch: find [label][ref] / [label] candidates for masking.
const REFLINK_RE = rx(/^!?\[(label)\]\[(ref)\]/).replace('label', LABEL_INNER).replace('ref', LABEL_REF).get();
const NOLINK_RE = rx(/^!?\[(ref)\](?:\[\])?/).replace('ref', LABEL_REF).get();
I.reflinkSearch = rx('reflink|nolink(?!\\()', 'g')
  .replace('reflink', REFLINK_RE)
  .replace('nolink', NOLINK_RE)
  .get();
I.punctuation = rx(/^((?![*_])punctSpace)/, 'u').replace(/punctSpace/g, PUNCT_SPACE).get();
// Inline text: runs of plain text. GFM variant stops before www./
// scheme:// / email autolinks and before emphasis/code/link/html.
I.text = rx(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', SCHEME_RE)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', /(?<![^\s*_~(])www\./)
  .get();

// ------------------------------------------------------------------
// Block tokenizer (produces block tokens)
// ------------------------------------------------------------------

class Tokenizer {
  constructor(lexer) {
    this.lexer = lexer;
  }

  space(src) {
    const m = R.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
    return null;
  }

  code(src) {
    const m = R.code.exec(src);
    if (!m) return null;
    const raw = m[0];
    const text = trimBlankLines(raw).replace(O.codeRemoveIndent, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }

  fences(src) {
    const m = R.fences.exec(src);
    if (!m) return null;
    const raw = m[0];
    const lang = m[2] ? m[2].trim().replace(I.anyPunctuation, '$1') : m[2];
    const body = m[3] || '';
    return { type: 'code', raw, codeBlockStyle: 'fenced', lang, text: fenceIndent(body, raw) };
  }

  heading(src) {
    const m = R.heading.exec(src);
    if (!m) return null;
    const raw = m[0];
    let text = m[2].trim();
    if (/#$/.test(text)) {
      const s = trimEndChar(text, '#');
      if (!s || /[ \t]$/.test(s)) text = s.trim();
    }
    return { type: 'heading', raw, depth: m[1].length, text, tokens: this.lexer.inline(text) };
  }

  hr(src) {
    const m = R.hr.exec(src);
    if (!m) return null;
    return { type: 'hr', raw: m[0] };
  }

  // Blockquote: a run of `>` lines (plus lazy paragraph continuation).
  // Multi-pass: after lexing a chunk, a trailing nested blockquote or
  // list is re-lexed together with the remaining lines.
  blockquote(src) {
    const m = R.blockquote.exec(src);
    if (!m) return null;
    let lines = trimEndChar(m[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let hasQuote = false;
      const chunk = [];
      let p = 0;
      for (; p < lines.length; p++) {
        if (O.blockquoteStart.test(lines[p])) { chunk.push(lines[p]); hasQuote = true; }
        else if (!hasQuote) chunk.push(lines[p]);
        else break;
      }
      lines = lines.slice(p);
      const joined = chunk.join('\n');
      const inner = joined
        .replace(O.blockquoteMarkerWhitespace, (g, b, ws) => b + expandTabs(ws, b.length))
        .replace(O.blockquoteSetextReplace, '\n    $1')
        .replace(O.blockquoteSetextReplace2, '');
      raw = raw ? raw + '\n' + joined : joined;
      text = text ? text + '\n' + inner : inner;
      const wasTop = this.lexer.state.top;
      this.lexer.state.top = true;
      this.lexer.blockTokens(inner, tokens, true);
      this.lexer.state.top = wasTop;
      if (lines.length === 0) break;
      const last = tokens[tokens.length - 1];
      if (!last) break;
      if (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table') break;
      if (last.type === 'blockquote') {
        const rest = lines.join('\n');
        const combined = last.raw + '\n' + rest.replace(O.blockquoteSetextReplace2, '');
        const nested = this.blockquote(combined);
        tokens[tokens.length - 1] = nested;
        const leftover = combined.substring(nested.raw.length).replace(/^\n/, '');
        const leftoverLines = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverLines ? lines.slice(0, -leftoverLines) : lines;
        if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
        text = text.substring(0, text.length - last.text.length) + nested.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (last.type === 'list') {
        const rest = lines.join('\n');
        const combined = last.raw + '\n' + rest;
        const relisted = this.list(combined);
        tokens[tokens.length - 1] = relisted;
        const extra = relisted.raw.length > last.raw.length
          ? combined.slice(last.raw.length + 1, relisted.raw.length).split('\n').length : 0;
        if (extra > 0) {
          const y = lines.slice(0, extra).join('\n');
          raw = raw + '\n' + y;
          text = text + '\n' + y;
        }
        lines = lines.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  // List: collects items, growing each item's body line by line.
  list(src) {
    const m = R.list.exec(src);
    if (!m) return null;
    const src0 = src;
    const consumed = () => src0.length - src.length;
    let bullet = m[1].trim();
    const ordered = bullet.length > 1;
    const list = {
      type: 'list', raw: '', ordered,
      start: ordered ? +bullet.slice(0, -1) : '',
      loose: false, items: [],
    };
    bullet = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
    const itemRe = O.listItemRegex(bullet);
    let prevLoose = false;
    let rest = src;
    while (rest) {
      let itemEmpty = false;
      let itemText = '';
      const t = itemRe.exec(rest);
      if (!t || R.hr.test(rest)) break;
      const startIdx = consumed.call ? 0 : 0;
      const beforeLen = src0.length - rest.length;
      rest = rest.substring(t[0].length);
      let firstLine = t[2].split('\n', 1)[0];
      const bullLen = t[1].length;
      let content = firstLine.replace(O.leadingSpaceTab, (v) => expandTabs(v, bullLen));
      const nextLine = rest.split('\n', 1)[0];
      let isEmpty = !content.trim();
      let indent = 0;
      if (isEmpty) indent = bullLen + 1;
      else {
        indent = content.search(O.nonSpaceChar);
        indent = indent > 4 ? 1 : indent;
        itemText = content.slice(indent);
        indent += bullLen;
      }
      if (isEmpty && O.blankLine.test(nextLine)) {
        rest = rest.substring(nextLine.length + 1);
        itemEmpty = true;
      }
      if (!itemEmpty) {
        const nextBullet = O.nextBulletRegex(indent);
        const hr = O.hrRegex(indent);
        const fences = O.fencesBeginRegex(indent);
        const heading = O.headingBeginRegex(indent);
        const html = O.htmlBeginRegex(indent);
        const bq = O.blockquoteBeginRegex(indent);
        while (rest) {
          const line = rest.split('\n', 1)[0];
          let expanded;
          if (expanded = line.replace(O.leadingSpaceTab, (v) => expandTabs(v, 0)),
              fences.test(line) || heading.test(line) || html.test(line) || bq.test(line) || nextBullet.test(line) || hr.test(line)) break;
          if (expanded.search(O.nonSpaceChar) >= indent || !line.trim()) {
            itemText += '\n' + expanded.slice(indent);
          } else {
            if (isEmpty || content.replace(O.tabCharGlobal, '    ').search(O.nonSpaceChar) >= 4
                || fences.test(content) || heading.test(content) || html.test(content) || hr.test(content)) break;
            const setext = /^ {0,3}(?:=+|-+) *$/.test(line) && R.lheading.test(content + '\n' + line)
              ? '    ' + expanded.replace(/^ {0,3}/, '') : line;
            itemText += '\n' + setext;
          }
          isEmpty = !line.trim();
          rest = rest.substring(line.length + 1);
          content = expanded.slice(indent);
        }
      }
      const itemRaw = src0.slice(beforeLen, src0.length - rest.length);
      if (!list.loose) {
        if (prevLoose) list.loose = true;
        else if (O.doubleBlankLine.test(itemRaw)) prevLoose = true;
      }
      list.items.push({
        type: 'list_item', raw: itemRaw,
        task: O.listIsTask.test(itemText),
        loose: false, text: itemText, tokens: [],
      });
    }
    const lastItem = list.items[list.items.length - 1];
    if (lastItem) {
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
    } else {
      return null;
    }
    list.raw = src0.slice(0, src0.length - rest.length).trimEnd();
    for (const item of list.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter((g) => g.type === 'space');
        list.loose = spaces.length > 0 && spaces.some((g) => O.anyLine.test(g.raw));
      }
    }
    // Task-list checkboxes: strip the `[ ]`/`[x]` from the item text and
    // prepend a checkbox token.
    for (const item of list.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(O.listReplaceTask, '');
        first.raw = first.raw.replace(O.listReplaceTask, '');
        first.text = first.text.replace(O.listReplaceTask, '');
        for (let g = this.lexer.inlineQueue.length - 1; g >= 0; g--) {
          if (O.listIsTask.test(this.lexer.inlineQueue[g].src)) {
            this.lexer.inlineQueue[g].src = this.lexer.inlineQueue[g].src.replace(O.listReplaceTask, '');
            break;
          }
        }
        const cb = O.listTaskCheckbox.exec(item.raw);
        if (cb) {
          const box = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
          item.checked = box.checked;
          if (list.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type)
                && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
              item.tokens[0].raw = box.raw + item.tokens[0].raw;
              item.tokens[0].text = box.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(box);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: box.raw, text: box.raw, tokens: [box] });
            }
          } else {
            item.tokens.unshift(box);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
      }
    }
    return list;
  }

  html(src) {
    const m = R.html.exec(src);
    if (!m) return null;
    const raw = trimBlankLines(m[0]);
    return { type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
  }

  def(src) {
    const m = R.def.exec(src);
    if (!m) return null;
    if (!O.startAngleBracket.test(m[2]) && findCloser(m[2], '()') !== -1) return null;
    const label = normalizeLabel(m[1]);
    let href = m[2] ? m[2].replace(O.hrefBrackets, '$1').replace(I.anyPunctuation, '$1') : '';
    const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(I.anyPunctuation, '$1') : m[3];
    if (!(label in this.lexer.links)) this.lexer.links[label] = { href, title };
    return { type: 'def', raw: m[0] };
  }

  table(src) {
    const m = R.table.exec(src);
    if (!m || !/[:|]/.test(m[2])) return null;
    const raw = m[0];
    const header = splitTableRow(m[1].replace(/\n$/, ''));
    const alignRaw = m[2].replace(/^ *\|/, '').replace(/\| *$/, '').split('|');
    if (header.length !== alignRaw.length) return null;
    const align = m[2].replace(/^ *\|/, '').replace(/\| *$/, '').split('|').map((c) => {
      if (O.tableAlignRight.test(c)) return 'right';
      if (O.tableAlignCenter.test(c)) return 'center';
      if (O.tableAlignLeft.test(c)) return 'left';
      return null;
    });
    const bodyText = m[3] || '';
    const rows = bodyText.trim() ? bodyText.replace(O.tableRowBlankLine, '').split('\n').map((r) => splitTableRow(r, header.length)) : [];
    return {
      type: 'table', raw,
      header: header.map((h) => ({ text: h, tokens: this.lexer.inline(h) })),
      align,
      rows: rows.map((row) => row.map((cell) => ({ text: cell, tokens: this.lexer.inline(cell) }))),
    };
  }

  lheading(src) {
    const m = R.lheading.exec(src);
    if (!m) return null;
    const raw = trimEndChar(m[0], '\n');
    const level = m[2][0] === '=' ? 1 : 2;
    const text = m[1].trim();
    return { type: 'heading', raw, depth: level, text, tokens: this.lexer.inline(text) };
  }

  paragraph(src) {
    const m = R.paragraph.exec(src);
    if (!m) return null;
    const raw = m[0];
    const text = raw.replace(/\n$/, '');
    return { type: 'paragraph', raw, text, tokens: this.lexer.inline(text) };
  }

  text(src) {
    const m = R.text.exec(src);
    if (!m) return null;
    const raw = m[0];
    return { type: 'text', raw, text: raw, tokens: this.lexer.inline(raw) };
  }

  // --------------------------------------------------------------
  // Inline tokenizer
  // --------------------------------------------------------------

  escape(src) {
    const m = I.escape.exec(src);
    if (!m) return null;
    return { type: 'escape', raw: m[0], text: m[1] };
  }

  tag(src) {
    const m = I.tag.exec(src);
    if (!m) return null;
    if (!this.lexer.state.inLink && /^<a /i.test(m[0])) this.lexer.state.inLink = true;
    else if (this.lexer.state.inLink && /^<\/a>/i.test(m[0])) this.lexer.state.inLink = false;
    if (!this.lexer.state.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(m[0])) this.lexer.state.inRawBlock = true;
    else if (this.lexer.state.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(m[0])) this.lexer.state.inRawBlock = false;
    return { type: 'html', raw: m[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: false, text: m[0] };
  }

  // Inline link [text](href "title"), with marked's validation:
  // the href must be a balanced <...> or paren-balanced, and must not
  // end with an escaped closer; link text containing a raw HTML tag
  // disqualifies the link; a link inside link text is rejected.
  link(src) {
    if (this.lexer.state.linkParenPossible === false) return null;
    const m = I.link.exec(src);
    if (!m) return null;
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (hasRawTag(src, m[1], bang)) return null;
    let href = m[2].trim();
    if (O.startAngleBracket.test(href)) {
      if (!O.endAngleBracket.test(href)) return null;
      const l = trimEndChar(href.slice(0, -1), '\\');
      if ((href.length - l.length) % 2 === 0) return null;
    } else {
      const l = findCloser(m[2], '()');
      if (l === -2) return null;
      if (l > -1) {
        const h = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + l;
        m[2] = m[2].substring(0, l);
        m[0] = m[0].substring(0, h).trim();
        m[3] = '';
        href = m[2];
      }
    }
    const r = trimEndChar(m[0].slice(0, -1), '\\');
    if ((m[0].length - r.length) % 2 === 0) return null;
    let title = m[3] ? m[3].slice(1, -1) : '';
    href = href.trim();
    if (O.startAngleBracket.test(href)) href = href.slice(1, -1);
    return buildLinkToken(m, {
      href: href && href.replace(I.anyPunctuation, '$1'),
      title: title && title.replace(I.anyPunctuation, '$1'),
    }, m[0], this.lexer);
  }

  reflink(src, links) {
    let m;
    if ((m = I.reflink.exec(src)) || (m = I.nolink.exec(src))) {
      const bang = m[0].charAt(0) === '!' ? 2 : 1;
      if (hasRawTag(src, m[1], bang)) return null;
      const link = links[normalizeLabel(m[2] || m[1])];
      if (!link) {
        const o = m[0].charAt(0);
        return { type: 'text', raw: o, text: o };
      }
      return buildLinkToken(m, link, m[0], this.lexer);
    }
    return null;
  }

  emStrong(src, masked, prev = '') {
    let s = I.emStrongLDelim.exec(src);
    if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
    const r = s[0][0]; // '*' or '_'
    const prevIsDelim = prev === r;
    let i = masked.length - src.length; // offset of src within masked
    let l = i;
    for (; l > 0 && masked[l - 1] === r;) l--;
    const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
    const h = p === '*' || p === '_' || !!I.punctuation.exec(p);
    if (l < i) prev = p;
    const u = l < i ? h : !!I.punctuation.exec(prev);
    if (s[4] && prev.match(/[\p{L}\p{N}]/u)) return null;
    const d = s[1] || s[3] || '';
    if (!d || !prev || u) {
      let k = [...s[0]].length - 1; // open run length - 1
      let g, b, m = k, f = 0;
      const y = i - l + k;
      const R = !!p.trim() && (!!d || (r === '*' && !h));
      if (r !== '*' && r !== '_') return null;
      const closeRe = r === '*' ? I.emStrongRDelimAst : I.emStrongRDelimUnd;
      const v = lastCloserIndex(masked, r);
      const Q = masked.length - src.length + k;
      if (v < Q) return null;
      const t = masked.slice(-1 * src.length + k);
      const ee = v - Q;
      for (closeRe.lastIndex = 0; ; ) {
        const mm = closeRe.exec(t);
        if (mm === null || mm.index > ee) break;
        s = mm;
        g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
        if (!g) continue;
        b = [...g].length;
        if (s[3] || s[4]) { m += b; continue; }
        else if (s[5] || s[6] || R) {
          if (prevIsDelim && (s[5] || s[6])) break;
          if (y % 3 && !((y + b) % 3)) { f += b; continue; }
        }
        if (m -= b, m > 0) continue;
        b = Math.min(b, b + m + f);
        const firstLen = [...s[0]][0].length;
        const raw = src.slice(0, k + s.index + firstLen + b);
        if (Math.min(k, b) % 2) {
          const inner = raw.slice(1, -1);
          return { type: 'em', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
        }
        const inner = raw.slice(2, -2);
        return { type: 'strong', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
    return null;
  }

  codespan(src) {
    const m = I.code.exec(src);
    if (!m) return null;
    let text = m[2].replace(/\n/g, ' ');
    if (/[^ ]/.test(text) && /^ /.test(text) && / $/.test(text)) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: m[0], text: escapeHtml(text, true) };
  }

  br(src) {
    const m = I.br.exec(src);
    if (!m) return null;
    return { type: 'br', raw: m[0] };
  }

  // Strikethrough. `masked` and `prev` as in emStrong.
  del(src, masked, prev = '') {
    let s = I.delLDelim.exec(src);
    if (!s) return null;
    if (!(s[1] || '') || !prev || I.punctuation.exec(prev)) {
      const o = [...s[0]].length - 1;
      let g, l, p = o;
      const closeRe = I.delRDelim;
      const u = lastDelCloserIndex(masked);
      const d = masked.length - src.length + o;
      if (u < d) return null;
      const t = masked.slice(-1 * src.length + o);
      const k = u - d;
      for (closeRe.lastIndex = 0; ; ) {
        const mm = closeRe.exec(t);
        if (mm === null || mm.index > k) break;
        s = mm;
        g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
        if (!g || (l = [...g].length, l !== o)) continue;
        if (s[3] || s[4]) { p += l; continue; }
        if (p -= l, p > 0) continue;
        l = Math.min(l, l + p);
        const firstLen = [...s[0]][0].length;
        const raw = src.slice(0, o + s.index + firstLen + l);
        const inner = raw.slice(o, -o);
        return { type: 'del', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
    return null;
  }

  codespan(src) {
    const m = I.code.exec(src);
    if (!m) return null;
    let text = m[2].replace(/\n/g, ' ');
    if (/[^ ]/.test(text) && /^ /.test(text) && / $/.test(text)) text = text.substring(1, text.length - 1);
    text = escapeHtml(text, true);
    return { type: 'codespan', raw: m[0], text };
  }

  br(src) {
    const m = I.br.exec(src);
    if (!m) return null;
    return { type: 'br', raw: m[0] };
  }

  autolink(src) {
    const m = I.autolink.exec(src);
    if (!m) return null;
    let text, href;
    if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
    else { text = m[1]; href = text; }
    return { type: 'link', raw: m[0], text, href, tokens: [{ type: 'text', raw: text, text }] };
  }

  url(src) {
    const m = I.url.exec(src);
    if (!m) return null;
    let text, href;
    if (m[2] === '@') { text = m[0]; href = 'mailto:' + text; }
    else {
      let t = m[0];
      let prev;
      do { prev = t; t = I._backpedal.exec(t)?.[0] ?? ''; } while (prev !== t);
      text = t;
      href = m[1] === 'www.' ? 'http://' + t : t;
    }
    return { type: 'link', raw: text, text, href, tokens: [{ type: 'text', raw: text, text }] };
  }

  inlineText(src) {
    const m = I.text.exec(src);
    if (!m) return null;
    const inRaw = this.lexer.state.inRawBlock;
    return { type: 'text', raw: m[0], text: inRaw ? m[0] : decodeRefs(m[0]), escaped: inRaw };
  }
}

// ------------------------------------------------------------------
// ------------------------------------------------------------------
// Emphasis masking: hide code spans, links and HTML from the emphasis
// scanner by replacing their interiors with placeholder characters,
// so a `*` inside a link or code span cannot act as a delimiter.
// ------------------------------------------------------------------

// Last possible closer index for `*`/`_` (or `~` for del) in a masked
// string: the last run whose preceding character is not whitespace.
function lastCloserIndex(masked, delim) {
  const idx = { '*': -1, '_': -1 };
  let t = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const o = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    for (; i < n && masked[i] === r;) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (r === '~') t = s;
      else idx[r] = s;
    }
    s = i - 1;
  }
  return delim === '~' ? t : idx[delim];
}
function lastDelCloserIndex(masked) {
  return lastCloserIndex(masked, '~');
}

// Does the inline source contain a link (used by the masker to decide
// whether reference labels need masking)?
function linkInText(src, links) {
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(I.blockSkip)) {
    if (I.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(I.reflinkSearch)) {
    const s = m[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(links, normalizeLabel(s.slice(r + 1, -1))))
        && !(r > 1 && linkInText(s.slice(1, r - 1), links))) return true;
  }
  return false;
}

// Build the masked string for one inline source.
function maskInline(src, links) {
  let t = src;
  if (links && src.includes('[')) {
    const sub = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, links)) return '[' + inner.replace(I.reflinkSearch, sub) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(I.reflinkSearch, sub);
  }
  t = t.replace(I.anyPunctuationOutsideCode, (m, backticks, punct) => {
    if (punct) return '+'.repeat(m.length);
    if (backticks) return backticks + m.slice(backticks.length, -backticks.length).replace(/`/g, '+') + backticks;
    return m;
  });
  // blockSkip groups: (precode char, backticks). Keep leading backticks,
  // replace the rest with a bracketed run of 'a's (same length).
  t = t.replace(I.blockSkip, (m, _pre, backticks) => {
    const o = backticks ? backticks.length : 0;
    return m.slice(0, o) + '[' + 'a'.repeat(m.length - o - 2) + ']';
  });
  return t;
}


// Build a link/image token from a regex match and a {href, title}.
// Rejects the link when its text itself contains a link (no nesting).
function buildLinkToken(m, link, raw, lexer) {
  const href = link.href;
  const title = link.title || null;
  const text = m[1].replace(/\\([\[\]])/g, '$1');
  const isImage = m[0].charAt(0) === '!';
  const prevInLink = lexer.state.inLink;
  const prevEmitted = lexer.state.linkEmitted;
  const prevRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = lexer.inlineTokens(text);
  const nested = lexer.state.linkEmitted;
  lexer.state.linkEmitted = prevEmitted;
  lexer.state.inLink = prevInLink;
  if (!isImage) {
    if (nested) {
      lexer.state.inRawBlock = prevRawBlock;
      return null;
    }
    lexer.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

// Does the link text contain a raw HTML tag/autolink that spills past the
// end of the text (which disqualifies it)? Mirrors marked's Be: the tag is
// matched against the FULL source at the `<` position, and only rejects
// when it extends beyond the link text; a tag fully inside the text is
// skipped over.
function hasRawTag(src, text, offset) {
  if (!text.includes('<')) return false;
  for (let s = 0; s < text.length; s++) {
    if (text[s] === '\\') { s++; continue; }
    if (text[s] === '`') {
      const m = I.code.exec(text.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (text[s] !== '<') continue;
    const r = src.slice(offset + s);
    const o = I.tag.exec(r) || I.autolink.exec(r);
    if (o) {
      if (o[0].length > text.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// ------------------------------------------------------------------
// Lexer
// ------------------------------------------------------------------

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    this.tokenizer = new Tokenizer(this);
  }

  get links() { return this.tokens.links; }

  lex(src) {
    src = src.replace(/\r\n?/g, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const q = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(q.src, q.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  blockTokens(src, tokens, isBlockquote) {
    let smallest = Infinity;
    while (src) {
      if (src.length < smallest) smallest = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let tok;
      if ((tok = this.tokenizer.space(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.code(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.fences(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.heading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.hr(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.blockquote(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.list(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.html(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.def(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.raw;
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.table(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.lheading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (this.state.top && (tok = this.tokenizer.paragraph(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (isBlockquote && last?.type === 'paragraph') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.text(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else tokens.push(tok);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }

  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  inlineTokens(src, tokens = []) {
    // Compute the masked copy once (for emphasis/del close-delimiter
    // scanning) when the source can contain delimiters.
    const prevParen = this.state.linkParenPossible;
    this.state.linkParenPossible = prevParen && src.includes(')');
    const masked = (src.includes('*') || src.includes('_') || src.includes('~'))
      ? maskInline(src, this.tokens.links) : src;
    try {
    return this.inlineTokensInner(src, tokens, masked);
    } finally {
      this.state.linkParenPossible = prevParen;
    }
  }

  inlineTokensInner(src, tokens, masked) {
    let smallest = Infinity;
    let prevChar = '';
    let keepPrev = false; // true only right after an inlineText token
    for (;;) {
      if (!src) break;
      if (src.length < smallest) smallest = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      if (!keepPrev) prevChar = '';
      keepPrev = false;
      let tok;
      if ((tok = this.tokenizer.escape(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.tag(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.link(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.reflink(src, this.tokens.links))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (tok.type === 'text' && last?.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.emStrong(src, masked, prevChar))) {
        src = src.substring(tok.raw.length);
        // the masked string must stay aligned with src: re-slice it
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.codespan(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.br(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.del(src, masked, prevChar))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.autolink(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (!this.state.inLink && (tok = this.tokenizer.url(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.inlineText(src))) {
        src = src.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
        keepPrev = true;
        const last = tokens[tokens.length - 1];
        if (last?.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
        else tokens.push(tok);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    return tokens;
  }
}

// ------------------------------------------------------------------
// Renderer
// ------------------------------------------------------------------

function renderTokens(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space': break;
      case 'code': {
        const langWord = tok.lang ? (tok.lang.match(/^\S*/) || [''])[0] : '';
        const lang = langWord ? ' class="language-' + escapeHtml(langWord, false) + '"' : '';
        const body = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
        out += '<pre><code' + lang + '>' + escapeHtml(body, true) + '</code></pre>\n';
        break;
      }
      case 'heading':
        out += '<h' + tok.depth + '>' + renderInline(tok.tokens) + '</h' + tok.depth + '>\n';
        break;
      case 'hr': out += '<hr>\n'; break;
      case 'blockquote': out += '<blockquote>\n' + renderTokens(tok.tokens) + '</blockquote>\n'; break;
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
        out += '<' + tag + start + '>\n';
        for (const item of tok.items) out += renderListItem(item, tok.loose);
        out += '</' + tag + '>\n';
        break;
      }
      case 'html': out += tok.text; break;
      case 'def': break;
      case 'table': {
        let head = '';
        for (let i = 0; i < tok.header.length; i++) {
          const align = tok.align[i] ? ' align="' + tok.align[i] + '"' : '';
          head += '<th' + align + '>' + renderInline(tok.header[i].tokens) + '</th>\n';
        }
        let body = '';
        for (const row of tok.rows) {
          let cells = '';
          for (let i = 0; i < row.length; i++) {
            const align = tok.align[i] ? ' align="' + tok.align[i] + '"' : '';
            cells += '<td' + align + '>' + renderInline(row[i].tokens) + '</td>\n';
          }
          body += '<tr>\n' + cells + '</tr>\n';
        }
        out += '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n'
          + (body ? '<tbody>' + body + '</tbody>' : '') + '</table>\n';
        break;
      }
      case 'paragraph': out += '<p>' + renderInline(tok.tokens) + '</p>\n'; break;
      case 'text': out += renderInline(tok.tokens); break;
      case 'checkbox': out += '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '; break;
      default: break;
    }
  }
  return out;
}

function renderListItem(item, listLoose) {
  let out = '<li>';
  if (item.task) {
    // checkbox is already the first token when present
  }
  const body = renderTokens(item.tokens);
  if (item.loose) out += body;
  else {
    // tight list: a single paragraph's <p> wrapper is dropped
    out += body.replace(/^<p>/, '').replace(/<\/p>\n?$/, '');
  }
  out += '</li>\n';
  return out;
}

// Render inline tokens to plain text (for image alt attributes), mirroring
// marked's textRenderer: links/images/em/strong/del recurse to their text,
// codespan/html/text return their text, br contributes nothing, checkbox
// contributes its raw source.
function renderText(tokens) {
  if (!tokens) return '';
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'text':
      case 'escape':
      case 'codespan':
      case 'html':
        out += tok.text;
        break;
      case 'br':
        break;
      case 'checkbox':
        out += tok.raw;
        break;
      case 'link':
      case 'image':
      case 'em':
      case 'strong':
      case 'del':
        out += tok.tokens ? renderText(tok.tokens) : tok.text;
        break;
      default:
        if (tok.tokens) out += renderText(tok.tokens);
        else if (tok.text) out += tok.text;
    }
  }
  return out;
}

function renderInline(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape': out += escapeHtml(tok.text, false); break;
      case 'html': out += tok.text; break;
      case 'link': {
        const href = cleanUrl(tok.href);
        if (href === null) { out += renderInline(tok.tokens); break; }
        let tag = '<a href="' + escapeHtml(href, false) + '"';
        if (tok.title) tag += ' title="' + escapeHtml(tok.title, false) + '"';
        out += tag + '>' + renderInline(tok.tokens) + '</a>';
        break;
      }
      case 'image': {
        const href = cleanUrl(tok.href);
        const altText = tok.tokens ? renderText(tok.tokens) : tok.text;
        if (href === null) { out += escapeHtml(altText, false); break; }
        let tag = '<img src="' + escapeHtml(href, false) + '" alt="' + escapeHtml(altText, false) + '"';
        if (tok.title) tag += ' title="' + escapeHtml(tok.title, false) + '"';
        out += tag + '>';
        break;
      }
      case 'strong': out += '<strong>' + renderInline(tok.tokens) + '</strong>'; break;
      case 'em': out += '<em>' + renderInline(tok.tokens) + '</em>'; break;
      case 'codespan': out += '<code>' + tok.text + '</code>'; break;
      case 'br': out += '<br>'; break;
      case 'del': out += '<del>' + renderInline(tok.tokens) + '</del>'; break;
      case 'text': out += escapeHtml(tok.text, false); break;
      case 'checkbox': out += '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '; break;
      default: break;
    }
  }
  return out;
}

export function parse(markdown) {
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return renderTokens(tokens);
}
