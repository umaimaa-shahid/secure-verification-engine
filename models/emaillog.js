
const mongoose = require("mongoose");

const emailLogSchema = new mongoose.Schema(
  {
    recipient: { type: String, required: true },
    subject: { type: String, required: true },
    status: {
      type: String,
      enum: ["sent", "failed", "delivered", "bounced"],
      default: "sent",
    },
    messageId: { type: String, index: true },
    error: { type: String }, 
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EmailLog", emailLogSchema);
