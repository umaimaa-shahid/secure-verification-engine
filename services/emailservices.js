
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const { smtpConfig } = require("../config/email");

// Create the transporter once and reuse it across requests.
const transporter = nodemailer.createTransport(smtpConfig);

/**
 * Load an HTML template from /templates and replace {{placeholders}}
 * with real values.
 * @param {string} templateName - e.g. "assetDelivery.html"
 * @param {Object} data - key/value pairs matching the placeholders
 * @returns {string} final HTML
 */
function renderTemplate(templateName, data = {}) {
  const filePath = path.join(__dirname, "..", "templates", templateName);
  let html = fs.readFileSync(filePath, "utf-8");

  for (const [key, value] of Object.entries(data)) {
    const pattern = new RegExp(`{{\\s*${key}\\s*}}`, "g");
    html = html.replace(pattern, value);
  }

  return html;
}

/**
 * Send an email.
 * @param {Object} params
 * @param {string} params.to      - recipient email address
 * @param {string} params.subject - email subject
 * @param {string} params.html    - final HTML body (template already filled in)
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendEmail({ to, subject, html }) {
  try {
    const info = await transporter.sendMail({
      from: smtpConfig.auth.user,
      to,
      subject,
      html,
    });

    return { success: true, messageId: info.messageId };
  } catch (err) {
    return { success: false, error: err.message };
  }
}


async function verifyConnection() {
  try {
    await transporter.verify();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { sendEmail, verifyConnection, renderTemplate };
