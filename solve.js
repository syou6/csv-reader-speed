// A faster drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's
// {columns, rows, errors} for every input {text, header}, following the same broken-row
// policy (BOM dropped; records end at LF or CRLF; empty lines are no records; a lone CR
// outside quotes is dropped as stray_cr; quoted fields run to the next undoubled quote
// with CRLF/CR inside read as LF; junk after a closing quote is appended (quote_junk);
// a quote that never closes is literal and its text is re-read unquoted
// (unterminated_quote); rows are padded (short_row) or cut (long_row) to the first
// record's width).
//
// Where the reference walks one character at a time, this reader scans with indexOf:
// a whole record that sits on one line with no quote and no stray CR is split in one
// call, a plain field is one slice between delimiters, and a quoted field whose next
// quote closes it with no line break inside is one slice. The slow paths below follow
// the reference step for step, so broken input answers exactly as it does.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const len = text.length;
  const hasCR = text.includes('\r');

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes.
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break; a CR not
  // followed by LF is dropped (stray_cr). Returns {value, ended, added}.
  function readUnquoted(value) {
    let added = 0;
    let single = value;
    let parts = null;
    const keep = (s) => {
      if (s === '') return;
      added += s.length;
      if (parts !== null) parts.push(s);
      else if (single !== '') { parts = [single, s]; single = null; }
      else single = s;
    };
    while (pos < len) {
      const ic = text.indexOf(',', pos);
      const il = text.indexOf('\n', pos);
      const ir = hasCR ? text.indexOf('\r', pos) : -1;
      let i = -1;
      let kind = END;
      if (ic !== -1) { i = ic; kind = COMMA; }
      if (il !== -1 && (i === -1 || il < i)) { i = il; kind = LINE_BREAK; }
      if (ir !== -1 && (i === -1 || ir < i)) { i = ir; kind = 3; }
      if (i === -1) {
        keep(text.slice(pos, len));
        pos = len;
        break;
      }
      if (kind === COMMA) {
        keep(text.slice(pos, i));
        pos = i + 1;
        return { value: parts !== null ? parts.join('') : single, ended: COMMA, added };
      }
      if (kind === LINE_BREAK) {
        keep(text.slice(pos, i));
        pos = i + 1;
        line += 1;
        return { value: parts !== null ? parts.join('') : single, ended: LINE_BREAK, added };
      }
      // A CR: CRLF ends the field; a lone CR is dropped and the read goes on.
      if (text.charCodeAt(i + 1) === 10) {
        keep(text.slice(pos, i));
        pos = i + 2;
        line += 1;
        return { value: parts !== null ? parts.join('') : single, ended: LINE_BREAK, added };
      }
      keep(text.slice(pos, i));
      error('stray_cr');
      pos = i + 1;
    }
    return { value: parts !== null ? parts.join('') : single, ended: END, added };
  }

  // What follows a quoted field's closing quote, pos just past it.
  function afterClose(value) {
    if (pos >= len) return { value, ended: END };
    const c = text[pos];
    if (c === ',') {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === '\n') {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === '\r' && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const start = pos + 1;
    // Fast path: the next quote closes the field and no line break sits inside it.
    const q = text.indexOf('"', start);
    if (q !== -1 && text.charCodeAt(q + 1) !== 34) {
      const ir = hasCR ? text.indexOf('\r', start) : -1;
      const il = text.indexOf('\n', start);
      if ((ir === -1 || ir > q) && (il === -1 || il > q)) {
        const value = text.slice(start, q);
        pos = q + 1;
        return afterClose(value);
      }
    }
    // General path: segments between quotes and line breaks, CR and CRLF read as LF.
    let parts = null;
    let single = '';
    const keep = (s) => {
      if (s === '') return;
      if (parts !== null) parts.push(s);
      else if (single !== '') { parts = [single, s]; single = null; }
      else single = s;
    };
    let p = start;
    while (p < len) {
      const iq = text.indexOf('"', p);
      const il = text.indexOf('\n', p);
      const ir = hasCR ? text.indexOf('\r', p) : -1;
      let i = -1;
      let kind = END;
      if (iq !== -1) { i = iq; kind = 0; }
      if (il !== -1 && (i === -1 || il < i)) { i = il; kind = 1; }
      if (ir !== -1 && (i === -1 || ir < i)) { i = ir; kind = 2; }
      if (i === -1) break;
      if (kind === 0) {
        if (text.charCodeAt(i + 1) === 34) {
          keep(text.slice(p, i));
          keep('"');
          p = i + 2;
          continue;
        }
        keep(text.slice(p, i));
        pos = i + 1;
        return afterClose(parts !== null ? parts.join('') : single);
      }
      keep(text.slice(p, i));
      keep('\n');
      line += 1;
      p = kind === 2 && text.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
    }
    // The quote never closes: it is a literal character, and the text after it is
    // read again as unquoted.
    pos = open + 1;
    line = openLine;
    error('unterminated_quote');
    return readUnquoted('"');
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields = null;
    let lastQuoted = false;

    // Fast path: the whole record sits on one line and holds no quote and no CR but
    // the CR of a closing CRLF, so it splits in one call and can hold no error.
    const nl = text.indexOf('\n', pos);
    const segEnd = nl === -1 ? len : nl;
    const qi = text.indexOf('"', pos);
    if (qi === -1 || qi >= segEnd) {
      const ri = hasCR ? text.indexOf('\r', pos) : -1;
      if (ri === -1 || ri >= segEnd || (ri === segEnd - 1 && nl !== -1)) {
        const seg = ri === segEnd - 1 && nl !== -1 ? text.slice(pos, segEnd - 1) : text.slice(pos, segEnd);
        fields = seg.split(',');
        pos = nl === -1 ? len : nl + 1;
        line += 1;
      }
    }

    if (fields === null) {
      fields = [];
      let field;
      do {
        lastQuoted = text[pos] === '"';
        field = lastQuoted ? readQuoted() : readUnquoted('');
        fields.push(field.value);
      } while (field.ended === COMMA);

      // A line that held only stray CRs is left with no characters: no record
      // (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
