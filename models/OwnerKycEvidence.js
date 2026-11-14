const mongoose = require("mongoose");

const asset = new mongoose.Schema({
  id: { type: String, required: true },
  format: { type: String, enum: ["jpg", "jpeg", "png", "pdf"], required: true },
}, { _id: false });

const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  identity: { type: asset, required: true },
  address: { type: asset, required: true },
  caseReference: { type: String, maxlength: 80 },
}, { timestamps: true });

module.exports = mongoose.model("OwnerKycEvidence", schema);
