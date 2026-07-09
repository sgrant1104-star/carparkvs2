const PDFDocument = require('pdfkit');

/** Draws the receipt/invoice content onto an already-created PDFDocument and ends it. */
function drawInvoicePdf(doc, invoice, carpark) {
  const currency = (n) => `$${parseFloat(n || 0).toFixed(2)}`;
  const line = () => {
    doc.moveDown(0.35);
    doc.moveTo(36, doc.y).lineTo(383, doc.y).strokeColor('#d5d8dc').lineWidth(0.5).stroke();
    doc.moveDown(0.45);
  };

  doc.rect(36, 36, 347, 52).fill('#1a5276');
  doc.fillColor('#ffffff').fontSize(15).font('Helvetica-Bold')
    .text(carpark.name || 'Car Storage Yard', 46, 48, { width: 327, align: 'center' });
  doc.fontSize(8).font('Helvetica')
    .text([carpark.address, carpark.phone].filter(Boolean).join(' · '), 46, 68, { width: 327, align: 'center' });
  doc.y = 100;

  doc.fillColor('#2c3e50').fontSize(11).font('Helvetica-Bold')
    .text(`Receipt / Invoice #${invoice.invoice_number}`, { align: 'center' });
  doc.moveDown(0.3);
  line();

  const dateIn     = invoice.date_in     ? new Date(invoice.date_in).toLocaleDateString('en-NZ')     : '';
  const returnDate = invoice.return_date ? new Date(invoice.return_date).toLocaleDateString('en-NZ') : '';

  doc.fillColor('#111').fontSize(9).font('Helvetica');
  const leftCol = 36;
  const rightCol = 220;
  let y = doc.y;
  doc.text(`Customer`, leftCol, y); doc.font('Helvetica-Bold').text(`${invoice.first_name || ''} ${invoice.last_name || ''}`.trim(), leftCol + 58, y);
  y += 14; doc.font('Helvetica');
  doc.text(`Phone`, leftCol, y); doc.text(invoice.phone || '—', leftCol + 58, y);
  doc.text(`Vehicle`, rightCol, y - 14); doc.font('Helvetica-Bold').text(invoice.rego || '—', rightCol + 48, y - 14);
  doc.font('Helvetica').text(`Key`, rightCol, y); doc.text(invoice.no_key ? 'No Key' : (invoice.key_number || '—'), rightCol + 48, y);
  y += 14;
  doc.text(`Date in`, leftCol, y); doc.text(`${dateIn} ${invoice.time_in || ''}`.trim(), leftCol + 58, y);
  doc.text(`Return`, rightCol, y); doc.text(`${returnDate} ${invoice.return_time || ''}`.trim(), rightCol + 48, y);
  y += 14;
  doc.text(`Stay`, leftCol, y); doc.text(`${invoice.stay_nights || 0} night(s)`, leftCol + 58, y);
  if (invoice.flight_info) {
    doc.text(`Flight`, rightCol, y); doc.text(`${invoice.flight_info}`, rightCol + 48, y, { width: 115 });
  }
  doc.y = y + 18;
  line();

  if (invoice.discount_percent > 0) doc.text(`Discount: ${invoice.discount_percent}%`);
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a5276').text(`Total: ${currency(invoice.total_price)}`, { align: 'right' });
  doc.moveDown(0.4);

  // Clear paid/owing status — this is the thing a customer actually needs
  // to know at a glance, not something to infer from raw payment fields.
  const amountPaid = Math.round((
    (parseFloat(invoice.payment_amount) || 0) +
    (parseFloat(invoice.payment_amount_2) || 0) +
    (parseFloat(invoice.credit_applied) || 0)
  ) * 100) / 100;
  const amountOwing = Math.max(0, Math.round(((parseFloat(invoice.total_price) || 0) - amountPaid) * 100) / 100);
  const isPaidInFull = amountOwing <= 0.01 && (invoice.paid_status && invoice.paid_status !== 'To Pay');

  const bannerY = doc.y;
  const bannerColor = isPaidInFull ? '#1e8449' : '#c0392b';
  doc.rect(36, bannerY, 347, 26).fill(bannerColor);
  doc.fillColor('#ffffff').fontSize(12).font('Helvetica-Bold').text(
    isPaidInFull ? 'PAID IN FULL' : `AMOUNT DUE: ${currency(amountOwing)}`,
    36, bannerY + 7, { width: 347, align: 'center' }
  );
  doc.y = bannerY + 34;

  doc.fontSize(9).font('Helvetica').fillColor('#333');
  if (invoice.credit_applied > 0) doc.text(`Credit applied: ${currency(invoice.credit_applied)}`);
  doc.text(`Payment: ${invoice.paid_status} — ${currency(invoice.payment_amount)}`);
  if (invoice.payment_amount_2 > 0) doc.text(`2nd payment: ${invoice.paid_status_2} — ${currency(invoice.payment_amount_2)}`);
  if (!isPaidInFull && amountOwing > 0.01) {
    doc.font('Helvetica-Bold').fillColor('#c0392b').text(`Balance still owing: ${currency(amountOwing)}`);
    doc.font('Helvetica').fillColor('#333');
  }
  line();

  if (carpark.bank_account_number) {
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#2c3e50').text('Pay via online banking');
    doc.font('Helvetica').fillColor('#333');
    if (carpark.bank_name) doc.text(`Bank: ${carpark.bank_name}`);
    if (carpark.bank_account_name) doc.text(`Account name: ${carpark.bank_account_name}`);
    doc.text(`Account number: ${carpark.bank_account_number}`);
    doc.text(`Reference: ${carpark.bank_reference || `Invoice #${invoice.invoice_number}`}`);
    line();
  }

  doc.fontSize(8).fillColor('#7f8c8d').text(`Thank you for choosing ${carpark.name || 'our car storage yard'}`, { align: 'center' });
  doc.end();
}

/** Streams the receipt PDF directly to an HTTP response (browser download/print). */
function streamInvoicePdf(res, invoice, carpark) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="receipt-${invoice.invoice_number}.pdf"`);
  const doc = new PDFDocument({ size: 'A5', margin: 36 });
  doc.pipe(res);
  drawInvoicePdf(doc, invoice, carpark);
}

/** Builds the receipt PDF as a Buffer — for email attachments. */
function buildInvoicePdfBuffer(invoice, carpark) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A5', margin: 36 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      drawInvoicePdf(doc, invoice, carpark);
    } catch (err) { reject(err); }
  });
}

module.exports = { drawInvoicePdf, streamInvoicePdf, buildInvoicePdfBuffer };
