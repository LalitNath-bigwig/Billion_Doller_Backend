const { createCipheriv, createDecipheriv, randomBytes } = require("node:crypto");

// https://member.rameeglobalpay.com/docs/#encryption
const algorithm = "aes-256-gcm";
const ivLength = 12;
const tagLength = 16;

function createCipher(accessKey) {
  if (typeof accessKey !== "string" || Buffer.byteLength(accessKey) !== 32) throw new Error("Use a 32-byte RameeGlobalPay access key.");
  const key = Buffer.from(accessKey, "utf8");

  return {
    encrypt(payload) {
      const iv = randomBytes(ivLength);
      const cipher = createCipheriv(algorithm, key, iv, { authTagLength: tagLength });
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
    },
    decrypt(data) {
      if (typeof data !== "string" || data.length > 64 * 1024) throw new Error("Invalid RameeGlobalPay envelope.");
      const bytes = Buffer.from(data, "base64");
      if (bytes.length <= ivLength + tagLength || bytes.toString("base64") !== data) {
        throw new Error("Invalid RameeGlobalPay envelope.");
      }
      const iv = bytes.subarray(0, ivLength);
      const decipher = createDecipheriv(algorithm, key, iv, { authTagLength: tagLength });
      decipher.setAuthTag(bytes.subarray(ivLength, ivLength + tagLength));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(ivLength + tagLength)), decipher.final()]).toString("utf8"));
    },
  };
}

function readLkrMinor(amount, maxWholeDigits = 6) {
  if (typeof amount !== "string" && typeof amount !== "number") throw new Error("Invalid provider amount.");
  const match = /^(\d{1,14})(?:\.(\d{1,2}))?$/.exec(String(amount));
  if (!match || match[1].length > maxWholeDigits) throw new Error("Invalid provider amount.");
  const minor = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) throw new Error("Invalid provider amount.");
  return minor;
}

module.exports = { createCipher, readLkrMinor };
