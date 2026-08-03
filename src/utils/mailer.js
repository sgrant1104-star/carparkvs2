const nodemailer = require('nodemailer');

const SMTP_MISSING_MSG =
  'Email is not configured. Set SMTP_USER and SMTP_PASS in the server environment (e.g. Railway or .env). For Gmail: use an App Password (Google Account → Security → 2-Step Verification → App passwords). Typical settings: SMTP_HOST=smtp.gmail.com SMTP_PORT=587 SMTP_SECURE=false';

function getTransporter() {
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim();
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    connectionTimeout: parseInt(process.env.SMTP_CONNECTION_TIMEOUT || '20000', 10),
    greetingTimeout: parseInt(process.env.SMTP_GREETING_TIMEOUT || '12000', 10),
    socketTimeout: parseInt(process.env.SMTP_SOCKET_TIMEOUT || '30000', 10),
    auth: { user, pass },
  });
}

function emailFrom() {
  const from = (process.env.EMAIL_FROM || '').trim();
  if (from) return from;
  const user = (process.env.SMTP_USER || '').trim();
  return user ? `BOI Car Storage <${user}>` : 'BOI Car Storage <noreply@localhost>';
}

function smtpErrorMessage(err) {
  const msg = String((err && err.message) || '');
  if (/535|badcredentials|invalid login|username and password not accepted/i.test(msg)) {
    return 'SMTP authentication failed (Gmail rejected login). Update SMTP_PASS to a current Gmail App Password, and ensure SMTP_USER matches that Gmail account.';
  }
  return msg || 'Email send failed';
}

module.exports = { getTransporter, emailFrom, smtpErrorMessage, SMTP_MISSING_MSG };
