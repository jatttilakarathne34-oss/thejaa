'use strict';
const PDFDocument = require('pdfkit');
const m = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const logoBuf = s => { const x = /^data:image\/(png|jpeg);base64,(.+)$/.exec(s || ''); return x ? Buffer.from(x[2], 'base64') : null; };
function local(utc, off) {
  const d = new Date((utc instanceof Date ? utc : new Date(String(utc).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(utc)) ? '' : 'Z'))).getTime() + off * 60000);
  const h = d.getUTCHours(), mi = String(d.getUTCMinutes()).padStart(2, '0');
  return { date: d.toISOString().slice(0, 10), time: `${h % 12 || 12}:${mi} ${h >= 12 ? 'PM' : 'AM'}` };
}
const q = v => (Math.round(v * 1000) / 1000).toString();

// ---------- A4 ----------
function a4(o, S) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: o.invoice_no, Author: S.business_name } });
  const off = parseInt(S.tz_offset || '330'), t = local(o.created_at, off), lg = logoBuf(S.logo);
  if (lg) { try { doc.image(lg, 40, 38, { fit: [64, 64] }); } catch {} }
  const tx = lg ? 114 : 40;
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(19).text(S.business_name || 'Business', tx, 40, { width: 330 });
  doc.font('Helvetica').fontSize(9).fillColor('#555').text([S.business_address, S.business_phone].filter(Boolean).join('\n'), tx, doc.y + 2, { width: 330 });
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#1d4ed8').text('INVOICE', 380, 40, { width: 175, align: 'right' });
  doc.font('Helvetica').fontSize(9.5).fillColor('#111')
    .text(`No: ${o.invoice_no}`, 380, 68, { width: 175, align: 'right' })
    .text(`Date: ${t.date}  ${t.time}`, { width: 175, align: 'right' })
    .text(`Served by: ${o.employee}`, { width: 175, align: 'right' })
    .text(`Payment: ${o.payment_method.toUpperCase()}`, { width: 175, align: 'right' });
  let y = 122;
  doc.moveTo(40, y).lineTo(555, y).strokeColor('#d1d5db').stroke(); y += 10;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#6b7280').text('BILL TO', 40, y);
  doc.font('Helvetica').fontSize(10.5).fillColor('#111').text(o.customer_name || 'Walk-in Customer', 40, y + 13);
  if (o.customer_phone) doc.fontSize(9.5).fillColor('#444').text(o.customer_phone);
  if (o.customer_address) doc.text(o.customer_address, { width: 300 });
  y = Math.max(doc.y, y + 40) + 12;
  const X = [40, 62, 300, 360, 440, 495], head = () => {
    doc.rect(40, y, 515, 22).fill('#1e293b'); doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9);
    doc.text('#', X[0] + 4, y + 7).text('Item', X[1], y + 7).text('Qty', X[2], y + 7, { width: 50, align: 'right' })
      .text('Unit Price', X[3], y + 7, { width: 70, align: 'right' }).text('Disc.', X[4], y + 7, { width: 50, align: 'right' })
      .text('Amount', X[5], y + 7, { width: 55, align: 'right' });
    y += 22;
  };
  head();
  o.items.forEach((i, n) => {
    if (y > 740) { doc.addPage(); y = 40; head(); }
    const sg = i.is_return ? -1 : 1;
    doc.font('Helvetica').fontSize(9.5).fillColor(i.is_return ? '#b91c1c' : '#111');
    doc.text(String(n + 1), X[0] + 4, y + 6).text((i.is_return ? '[RETURN] ' : '') + i.name, X[1], y + 6, { width: 230, lineBreak: false, ellipsis: true })
      .text(q(i.qty), X[2], y + 6, { width: 50, align: 'right' }).text(m(i.unit_price), X[3], y + 6, { width: 70, align: 'right' })
      .text(i.discount_amt ? `${m(i.discount_amt * sg)} (${q(i.discount_pct)}%)` : '-', X[4] - 20, y + 6, { width: 70, align: 'right' })
      .text(m(i.line_total), X[5], y + 6, { width: 55, align: 'right' });
    y += 22; doc.moveTo(40, y).lineTo(555, y).strokeColor('#e5e7eb').stroke();
  });
  if (y > 640) { doc.addPage(); y = 40; }
  y += 14;
  const row = (l, v, b, c) => { doc.font(b ? 'Helvetica-Bold' : 'Helvetica').fontSize(b ? 12 : 10).fillColor(c || '#111').text(l, 340, y, { width: 110 }).text(v, 450, y, { width: 105, align: 'right' }); y += b ? 22 : 17; };
  row('Subtotal', m(o.subtotal)); row('Total Discount', '- ' + m(o.discount_total));
  if (o.tax_total) row('Tax', m(o.tax_total));
  doc.moveTo(340, y).lineTo(555, y).strokeColor('#111').stroke(); y += 6;
  row('Total Payable', 'Rs. ' + m(o.total), true, '#1d4ed8');
  row('Paid', m(o.paid));
  if (o.total - o.paid > 0.005) row('Balance Due', m(o.total - o.paid), true, '#b91c1c');
  if (o.prev_outstanding > 0.005) row('Previous Outstanding', m(o.prev_outstanding));
  if (o.note) doc.font('Helvetica-Oblique').fontSize(9).fillColor('#555').text('Note: ' + o.note, 40, y + 10, { width: 280 });
  doc.font('Helvetica').fontSize(9).fillColor('#6b7280').text(S.receipt_footer || 'Thank you for your business!', 40, 790, { width: 515, align: 'center' });
  if (o.status === 'cancelled') { doc.save().rotate(-30, { origin: [300, 420] }).opacity(0.18).font('Helvetica-Bold').fontSize(90).fillColor('#dc2626').text('CANCELLED', 40, 380, { width: 520, align: 'center' }).restore(); }
  doc.end(); return doc;
}

// ---------- 57mm thermal (matches the Alankulama-style receipt) ----------
function thermalDraw(doc, o, S) {
  const M = 6, W = 161.4 - 2 * M, off = parseInt(S.tz_offset || '330'), t = local(o.created_at, off);
  const line = () => { const y = doc.y + 3; doc.moveTo(M, y).lineTo(M + W, y).dash(2, { space: 2 }).lineWidth(0.8).strokeColor('#000').stroke().undash(); doc.y = y + 6; };
  const pair = (l, r, b, sz) => { const y = doc.y; doc.font(b ? 'Helvetica-Bold' : 'Helvetica').fontSize(sz || 9.5).fillColor('#000'); doc.text(l, M, y, { width: W, lineBreak: false }); doc.text(r, M, y, { width: W, align: 'right', lineBreak: false }); doc.y = y + (sz || 9.5) + 3.5; };
  const txt = (s, o2 = {}) => doc.font(o2.b ? 'Helvetica-Bold' : 'Helvetica').fontSize(o2.sz || 9.5).fillColor('#000').text(s, M, doc.y, { width: W, align: o2.al || 'left' });
  doc.y = 8;
  const lg = logoBuf(S.logo); if (lg) { try { doc.image(lg, M + W / 2 - 20, doc.y, { fit: [40, 40] }); doc.y += 44; } catch {} }
  txt(S.business_name || 'Business', { b: 1, sz: 14, al: 'center' });
  if (S.business_address) txt(S.business_address, { sz: 9, al: 'center' });
  if (S.business_phone) txt(S.business_phone, { sz: 9, al: 'center' });
  line();
  txt('SALES INVOICE', { b: 1, sz: 11, al: 'center' }); doc.y += 3;
  txt(`INV REF No : ${o.invoice_no}`); txt(`${t.date} ${t.time}`);
  txt(`Rep      : ${o.employee}`); if (S.route_name) txt(`Route   : ${S.route_name}`);
  txt(`Customer : ${(o.customer_name || 'Walk-in').toUpperCase()}`);
  line();
  pair('Item', 'Amount', true); line();
  o.items.forEach(i => {
    txt((i.is_return ? '[RET] ' : '') + i.name.toUpperCase(), { b: 1 });
    pair(`   ${m(i.unit_price)} x ${q(i.qty)}`, m(i.line_total));
    if (i.discount_amt) pair(`   Disc ${q(i.discount_pct)}%`, '-' + m(i.discount_amt), false, 8.5);
  });
  line();
  pair('Gross Amount :', m(o.subtotal)); pair('Discount :', m(o.discount_total));
  if (o.tax_total) pair('Tax :', m(o.tax_total));
  line();
  pair('Net Amount :', m(o.total), true, 11); pair('Outstanding :', m(o.prev_outstanding));
  pair('Net Payable :', m(o.total + o.prev_outstanding), true, 11); pair('Paid Amount :', m(o.paid));
  pair('Payment :', o.payment_method.toUpperCase());
  line();
  if (o.status === 'cancelled') txt('*** CANCELLED ***', { b: 1, sz: 12, al: 'center' });
  txt(S.receipt_footer || 'Thank you!', { sz: 9, al: 'center' }); txt('powered by BillEase', { sz: 7.5, al: 'center' });
  return doc.y + 14;
}
function thermal(o, S) {
  const probe = new PDFDocument({ size: [161.4, 6000], margin: 0 }); probe.on('data', () => {});
  const h = Math.ceil(thermalDraw(probe, o, S)); probe.end();
  const doc = new PDFDocument({ size: [161.4, h], margin: 0, info: { Title: o.invoice_no } });
  thermalDraw(doc, o, S); doc.end(); return doc;
}
function invoicePDF(o, S, format) { return format === 'thermal' ? thermal(o, S) : a4(o, S); }

// ---------- Report PDF ----------
function reportPDF(d, S) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: 'Sales Report' } });
  doc.font('Helvetica-Bold').fontSize(20).text(S.business_name || 'Business');
  doc.font('Helvetica').fontSize(11).fillColor('#555').text(`Sales Report: ${d.range.from} to ${d.range.to}`).moveDown(1);
  const kv = (k, v) => { const y = doc.y; doc.fillColor('#111').font('Helvetica').fontSize(10.5).text(k, 40, y, { width: 250 }).font('Helvetica-Bold').text(v, 300, y, { width: 255, align: 'right' }); doc.moveDown(0.3); };
  const r = d.range_stats;
  kv('Total revenue', 'Rs. ' + m(r.revenue)); kv('Orders', String(r.orders)); kv('Average order value', 'Rs. ' + m(r.avg_order));
  kv('Total discounts', 'Rs. ' + m(r.discounts)); kv('Tax collected', 'Rs. ' + m(r.tax));
  kv('Paid orders / Unpaid-partial orders', `${r.paid_orders} / ${r.unpaid_orders}`); kv('Outstanding creditor balance', 'Rs. ' + m(d.outstanding));
  const table = (title, cols, rows) => {
    doc.moveDown(1).font('Helvetica-Bold').fontSize(12).fillColor('#1d4ed8').text(title).moveDown(0.3);
    const w = 515 / cols.length; const hdr = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#111'); cols.forEach((c, i) => doc.text(c, 40 + i * w, hdr, { width: w - 4, align: i ? 'right' : 'left' }));
    doc.y = hdr + 14;
    rows.forEach(rw => { if (doc.y > 770) doc.addPage(); const y = doc.y; doc.font('Helvetica').fontSize(9); rw.forEach((c, i) => doc.text(String(c), 40 + i * w, y, { width: w - 4, align: i ? 'right' : 'left', lineBreak: false, ellipsis: true })); doc.y = y + 13; });
  };
  table('Payment methods', ['Method', 'Orders', 'Revenue'], d.payments.map(p => [p.method, p.orders, m(p.revenue)]));
  table('Best-selling products', ['Product', 'Qty', 'Revenue', 'Discount'], d.products.slice(0, 15).map(p => [p.name, q(p.qty), m(p.revenue), m(p.discount)]));
  table('Employee performance', ['Name', 'Role', 'Orders', 'Revenue', 'Discounts'], d.employees.map(e => [e.name, e.role, e.orders, m(e.revenue), m(e.discounts)]));
  table('Sales by day', ['Date', 'Orders', 'Revenue'], d.series.day.map(s => [s.label, s.orders, m(s.revenue)]));
  doc.end(); return doc;
}
module.exports = { invoicePDF, reportPDF };
