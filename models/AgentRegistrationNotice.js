const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  _id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  claimToken: { type: String, required: true },
  claimedAt: { type: Date, required: true },
  telegramMessageId: Number,
}, { versionKey: false });

module.exports = mongoose.model("AgentRegistrationNotice", schema);
