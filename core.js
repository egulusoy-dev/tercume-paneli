// Shared logic for the notary translation system.
// Used by the Supabase Edge Function (automation) and by the dashboard (browser).

export const norm = s => String(s ?? '').replace(/[´`’']/g, "'").replace(/\s+/g, ' ').trim().toLocaleLowerCase('tr');
export const nums = s => (String(s ?? '').match(/\d+/g) || []).sort().join(',');
export const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
// Remove control characters that make Word reject the file
export const clean = s => String(s ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
export const toNum = s => { const v = parseFloat(String(s ?? '').replace(',', '.')); return isNaN(v) ? null : v; };

export const LANG = {
  'tr->az': { src: 'Turkish (Turkey)', tgt: 'Azerbaijani (Latin script)', from: 'Türk', to: 'Azerbaycan', stamp: 'İmza və möhür var.', sign: '' },
  'az->tr': { src: 'Azerbaijani', tgt: 'Turkish (Turkey)', from: 'Azerbaycan', to: 'Türk', stamp: '(Mühür var)', sign: '(İmza var)' },
};

export const READ_PROMPT = `You are a precise OCR engine for official documents (transcripts, diplomas, IDs, passports, certificates, reports).
Transcribe EXACTLY what is printed. Never translate, never correct spelling, never guess. Unreadable text -> "[?]".
Return ONLY JSON:
{
 "doc_type": "transcript|diploma|passport|id_card|certificate|criminal_record|health_report|other",
 "header_lines": ["title lines at the top, in order"],
 "info": [{"label": "printed label", "value": "printed value", "kind": "name|id|date|number|place|text"}],
 "table": null | {
   "corner": "text of the top-left header cell, e.g. DERSLER",
   "groups": ["column group titles left to right, e.g. '9. Sınıf 2022-2023'"],
   "sub_columns": ["sub-column titles repeated under every group, e.g. 'Haftalık Ders Saati', 'Yıl Sonu Puanı'"],
   "rows": [{"label": "row title", "cells": ["one string per group x sub_column, '' if empty"]}],
   "summary_rows": [{"label": "e.g. TOPLAM or ORTALAMA", "cells": ["same length as rows cells"]}]
 },
 "body_text": ["running text paragraphs, in order"],
 "notes": ["small printed notes and legends, one line each"],
 "signatures": [{"name": "printed name", "title": "printed title", "date": "date near it or ''"}],
 "has_stamp": true,
 "document_date": "date printed on the document or ''"
}
Rules: every row must have exactly groups.length * sub_columns.length cells. Keep decimal points as printed. Include every row and every line.`;

// Turkish words that should not stay in an Azerbaijani translation
const TR_ONLY = [/^baba/, /^mühür/, /^sorgu/, /^okul/, /^müdür/, /^öğren/, /^eğitim/, /^ile$/, /^için$/, /^yok$/, /^değil/, /^belge/, /^tarih$/, /^ve$/, /^sınıf/, /^puan/, /^ders$/, /^haftalık/, /^yıl$/, /^ortalama/, /^toplam/, /^ahlâk/, /^bilgisi$/, /^öğretim/];

// ---------- glossary ----------
export function lookups(G) {
  const exact = Object.create(null), suggested = Object.create(null), open = Object.create(null);
  for (const sec of ['header', 'fields', 'subjects', 'diploma', 'other_documents', 'degrees', 'grades', 'patronymic'])
    for (const [k, v] of Object.entries(G[sec] || {})) if (!k.startsWith('_') && typeof v === 'string') exact[norm(k)] = v;
  for (const [k, v] of Object.entries(G.not_in_sample_suggested || {})) if (!k.startsWith('_')) suggested[norm(k)] = v;
  for (const [k, v] of Object.entries(G.needs_translator_decision || {})) if (!k.startsWith('_')) open[norm(k)] = v;
  const omit = ((G.omit_notes || {}).patterns || []).map(p => new RegExp(p, 'iu'));
  return { exact, suggested, open, omit };
}
export const openOptions = o => o.options || [o.suggested, o.sample].filter(Boolean);

// Every translatable string on a page: {src, kind, where}
export function collectTexts(doc, L) {
  const texts = [];
  const add = (src, kind, where) => { if (src && /\p{L}/u.test(String(src))) texts.push({ src: String(src), kind, where }); };
  (doc.header_lines || []).forEach((s, i) => add(s, 'header', `Başlık ${i + 1}`));
  (doc.info || []).forEach(x => { add(x.label, 'label', x.label); if (x.kind === 'text') add(x.value, 'value', `${x.label} (değer)`); });
  const T = doc.table && doc.table.rows ? doc.table : null;
  if (T) {
    add(T.corner, 'label', 'Tablo başlığı');
    (T.groups || []).forEach(s => add(s, 'label', s));
    (T.sub_columns || []).forEach(s => add(s, 'label', s));
    T.rows.forEach(r => add(r.label, 'subject', r.label));
    (T.summary_rows || []).forEach(r => add(r.label, 'label', r.label));
  }
  (doc.body_text || []).forEach((s, i) => add(s, 'text', `Metin ${i + 1}`));
  visibleNotes(doc, L).forEach(s => add(s, 'note', s));
  (doc.signatures || []).forEach(s => add(s.title, 'label', `İmza: ${s.name}`));
  return texts;
}
export const visibleNotes = (doc, L) => (doc.notes || []).filter(n => !L.omit.some(r => r.test(n)));

// Glossary first; returns strings the model still has to translate
export function glossaryPass(texts, L) {
  const tr = Object.create(null), pending = [];
  for (const t of texts) {
    const k = norm(t.src);
    if (k in tr) continue;
    if (L.exact[k] !== undefined) tr[k] = L.exact[k];
    else if (L.open[k]) tr[k] = openOptions(L.open[k])[0];
    else if (L.suggested[k]) tr[k] = L.suggested[k];
    else { tr[k] = ''; pending.push(t); }
  }
  return { tr, pending };
}

// ---------- deterministic checks ----------
export function runChecks(doc, tr, G, dir) {
  const L = lookups(G), texts = collectTexts(doc, L), issues = [];
  const flag = (where, level, why, key) => issues.push({ where, level, why, key });
  const seen = new Set();
  for (const t of texts) {
    const k = norm(t.src); if (seen.has(t.where + '|' + k)) continue; seen.add(t.where + '|' + k);
    const out = own(tr, k) || '';
    const known = L.exact[k] !== undefined;
    if (L.open[k] && !(G._decided || {})[k]) {
      const opts = openOptions(L.open[k]);
      if (opts.includes(out)) flag(t.where, 'yellow', `Karar verilmemiş terim. Seçenekler: ${opts.map(x => `"${x}"`).join(' / ')}`, k);
    } else if (L.suggested[k] && out === L.suggested[k]) flag(t.where, 'yellow', `Önerilen terim, onaylayın: "${out}"`, k);
    if (!out.trim()) { flag(t.where, 'red', 'Çeviri boş', k); continue; }
    if (nums(t.src) !== nums(out)) flag(t.where, 'red', 'Rakamlar orijinalle aynı değil', k);
    if (dir === 'az->tr' && /[əƏqQxX]/.test(out)) flag(t.where, 'red', 'Çevrilmemiş Azerbaycan harfi (ə/q/x)', k);
    if (dir === 'tr->az') {
      const left = (norm(out).match(/\p{L}+/gu) || []).filter(w => TR_ONLY.some(r => r.test(w)));
      if (left.length) flag(t.where, 'yellow', `Türkçe kelime kalmış olabilir: ${[...new Set(left)].join(', ')}`, k);
    }
    if (!known && !L.open[k] && !L.suggested[k] && norm(out) === k) flag(t.where, 'yellow', 'Çeviri orijinalle aynı, kontrol edin', k);
    if (t.kind === 'subject' && !known && !L.open[k] && !L.suggested[k]) flag(t.where, 'yellow', `Yeni ders adı, sözlükte yok: "${out}"`, k);
  }
  const unread = (JSON.stringify(doc).match(/\[\?\]/g) || []).length;
  if (unread) flag('Belge', 'red', `${unread} yer okunamadı ([?]): orijinalle karşılaştırın`);
  tableChecks(doc).forEach(x => issues.push(x));
  return issues;
}

// Hours must add up to TOPLAM and the hours-weighted mean must equal ORTALAMA
export function tableChecks(doc) {
  const T = doc.table, out = [];
  if (!T || !T.rows || !T.groups || !T.sub_columns) return out;
  const nSub = T.sub_columns.length;
  const hIdx = T.sub_columns.findIndex(s => /saat/i.test(s));
  const pIdx = T.sub_columns.findIndex(s => /puan|not|qiymət/i.test(s));
  const total = (T.summary_rows || []).find(r => /toplam|cəmi/i.test(r.label));
  const avg = (T.summary_rows || []).find(r => /ortalama|orta/i.test(r.label));
  if (hIdx < 0) return out;
  T.groups.forEach((g, gi) => {
    const col = c => T.rows.map(r => toNum((r.cells || [])[gi * nSub + c]));
    const H = col(hIdx), P = pIdx >= 0 ? col(pIdx) : [];
    if (H.every(v => v === null)) return;
    if (total) {
      const printed = toNum((total.cells || []).slice(gi * nSub, gi * nSub + nSub).find(v => toNum(v) !== null));
      const sum = H.reduce((a, v) => a + (v || 0), 0);
      if (printed !== null && Math.abs(sum - printed) > 0.001)
        out.push({ where: g, level: 'red', why: `Saatlerin toplamı ${sum}, belgede ${printed}: bir sayı yanlış okunmuş veya bir satır eksik olabilir`, group: gi });
    }
    if (avg && pIdx >= 0) {
      const printed = toNum((avg.cells || []).slice(gi * nSub, gi * nSub + nSub).find(v => toNum(v) !== null));
      let hs = 0, h = 0; H.forEach((hv, i) => { if (hv !== null && P[i] !== null) { hs += hv * P[i]; h += hv; } });
      if (printed !== null && h > 0 && Math.abs(hs / h - printed) > 0.01)
        out.push({ where: g, level: 'red', why: `Puanların ağırlıklı ortalaması ${(hs / h).toFixed(4)}, belgede ${printed}: bir puan yanlış okunmuş olabilir`, group: gi });
    }
  });
  return out;
}

// ---------- Word file (.docx) without libraries ----------
export function turkishDate(d = new Date()) {
  const m = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
  const dd = String(d.getDate()).padStart(2, '0'), mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()} yılı ${m[d.getMonth()]} ayının ${dd}.Günü ${dd}/${mm}/${d.getFullYear()}`;
}

export function buildBody(doc, tr, G, dir, footerText, { issues = [], date = new Date() } = {}) {
  const L = lookups(G), D = LANG[dir];
  const T_ = s => (s ? (own(tr, norm(s)) || s) : s);
  const esc = s => clean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const FILL = { red: 'F8C9C9', yellow: 'FFF0B3' };
  const level = where => (issues.some(i => i.where === where && i.level === 'red') ? 'red' : issues.some(i => i.where === where) ? 'yellow' : null);
  const numCell = v => (dir === 'tr->az' ? String(v ?? '').replace(/(\d)\.(\d)/g, '$1,$2') : String(v ?? ''));
  const value = x => (x.kind === 'text' ? T_(x.value) : x.kind === 'number' ? numCell(x.value) : String(x.value ?? ''));
  const run = (t, { b = false, sz = 20 } = {}) =>
    `<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>${b ? '<w:b/>' : ''}<w:sz w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
  const para = (t, { b, sz, align, after = 0 } = {}) =>
    `<w:p><w:pPr><w:spacing w:before="0" w:after="${after}" w:line="240" w:lineRule="auto"/>${align ? `<w:jc w:val="${align}"/>` : ''}<w:rPr><w:sz w:val="${sz || 20}"/></w:rPr></w:pPr>${t === '' ? '' : run(t, { b, sz })}</w:p>`;
  const cell = (t, { w, b, sz = 16, span = 1, vm, fill, align } = {}) =>
    `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${vm ? `<w:vMerge${vm === 'restart' ? ' w:val="restart"' : ''}/>` : ''}${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ''}<w:vAlign w:val="center"/></w:tcPr>${para(t, { b, sz, align })}</w:tc>`;
  const table = (rows, widths) => {
    const B = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`).join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblBorders>${B}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="50" w:type="dxa"/><w:right w:w="50" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows.map(r => `<w:tr>${r.join('')}</w:tr>`).join('')}</w:tbl>`;
  };
  const W = 10716, body = [];

  (doc.header_lines || []).forEach((h, i) => body.push(para(i === 0 ? T_(h).toLocaleUpperCase('tr') : T_(h), { b: true, sz: i === 0 ? 22 : 20, align: 'center' })));
  body.push(para(''));

  const info = doc.info || [];
  if (info.length) {
    const cw = [2000, 3358, 2000, 3358], rows = [];
    for (let i = 0; i < info.length; i += 2) {
      const r = [];
      for (const x of [info[i], info[i + 1]]) {
        if (!x) { r.push(cell('', { w: cw[2] }), cell('', { w: cw[3] })); continue; }
        const f = FILL[level(x.label)] || FILL[level(`${x.label} (değer)`)];
        r.push(cell(T_(x.label), { w: cw[0], b: true, sz: 18, fill: f }), cell(value(x), { w: cw[1], sz: 18, fill: f }));
      }
      rows.push(r);
    }
    body.push(table(rows, cw), para(''));
  }

  const T = doc.table && doc.table.rows ? doc.table : null;
  if (T) {
    const nSub = T.sub_columns.length;
    const keep = T.groups.map((g, gi) => [...T.rows, ...(T.summary_rows || [])].some(r => (r.cells || []).slice(gi * nSub, gi * nSub + nSub).some(c => String(c ?? '').trim())));
    const groups = T.groups.map((g, gi) => ({ g, gi })).filter(x => keep[x.gi]);
    const first = 2900, rest = Math.floor((W - first) / Math.max(1, groups.length * nSub));
    const widths = [first, ...Array(groups.length * nSub).fill(rest)];
    const rows = [];
    rows.push([cell(T_(T.corner || ''), { w: first, b: true, vm: 'restart', align: 'center' }),
      ...groups.map(({ g }) => cell(T_(g), { w: rest * nSub, span: nSub, b: true, align: 'center', fill: FILL[level(g)] }))]);
    rows.push([cell('', { w: first, vm: 'cont' }), ...groups.flatMap(() => T.sub_columns.map(s => cell(T_(s), { w: rest, b: true, align: 'center' })))]);
    const line = (r, b) => [cell(T_(r.label), { w: first, b, fill: FILL[level(r.label)] }),
      ...groups.flatMap(({ g, gi }) => (r.cells || []).slice(gi * nSub, gi * nSub + nSub).map(c => cell(numCell(c), { w: rest, b, align: 'center', fill: FILL[level(g)] })))];
    T.rows.forEach(r => rows.push(line(r, false)));
    (T.summary_rows || []).forEach(r => rows.push(line(r, true)));
    body.push(table(rows, widths));
  }

  (doc.body_text || []).forEach(t => body.push(para(T_(t), { after: 60 })));
  visibleNotes(doc, L).forEach(t => body.push(para(T_(t), { sz: 18 })));
  (doc.signatures || []).forEach(s => body.push(para(
    [s.name, T_(s.title)].filter(Boolean).join(' — ') + '. ' + [D.sign, doc.has_stamp ? D.stamp : ''].filter(Boolean).join(' ') +
    ((s.date || doc.document_date) ? ' ' + (s.date || doc.document_date) : ''), { sz: 18 })));
  const footer = (footerText || '').replace(/\{from\}/g, D.from).replace(/\{to\}/g, D.to).replace(/\{date\}/g, turkishDate(date));
  footer.split('\n').forEach(l => body.push(l.startsWith('>') ? para(l.slice(1).trim(), { b: true, align: 'right' }) : para(l, { b: /^TERCÜMAN$/.test(l.trim()), sz: 18 })));

  if (issues.length) {
    body.push(para(''), para('KONTROL NOTLARI (bu bölüm teslim edilmez)', { b: true }));
    issues.forEach(i => body.push(para(`${i.level === 'red' ? 'KIRMIZI' : 'SARI'} · ${i.where}: ${i.why}`, { sz: 18 })));
  }
  return body.join('');
}

export function wrapDocx(bodies) {
  const brk = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodies.join(brk)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="510" w:right="595" w:bottom="482" w:left="595" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return zip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: xml },
  ]);
}

function zip(files) {
  const enc = new TextEncoder();
  const crc32 = buf => { let crc = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) { let c = (crc ^ buf[i]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xFFFFFFFF) >>> 0; };
  const chunks = [], central = []; let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(12, 0x21, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    chunks.push(new Uint8Array(lh.buffer), name, data); central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, c) => a + c.length, 0)); let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}
