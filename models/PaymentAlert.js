const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  _id: String,
  paymentId: mongoose.Schema.Types.ObjectId,
  type: { type: String, enum: ["deposit", "withdrawal"] },
  dueAt: Date,
  lastSentAt: Date,
  messageId: Number,
  claim: String,
  claimedAt: Date,
  dispatching: Boolean,
}, { versionKey: false });
schema.index({ dueAt: 1 }, { sparse: true });
const cursor = new mongoose.Schema({ _id: String, startedAt: Date, through: Date }, { versionKey: false });

exports.Alert = mongoose.model("PaymentAlert", schema);
exports.Cursor = mongoose.model("PaymentAlertCursor", cursor);
