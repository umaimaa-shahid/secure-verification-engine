
require("dotenv").config();

const smtpConfig = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465, 
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
};

const imapConfig = {
  host: process.env.IMAP_HOST,
  port: Number(process.env.IMAP_PORT) || 993,
  secure: true,
  auth: {
    user: process.env.IMAP_USER,
    pass: process.env.IMAP_PASS,
  },
};

module.exports = { smtpConfig, imapConfig };
