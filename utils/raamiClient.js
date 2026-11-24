// Raami merchant API SDK (Node.js >= 14, no dependencies). 
const crypto = require('crypto');
const http = require('http');
const https = require('https');  
const result = (success, httpStatus, message, data = null) => ({ success, httpStatus, message, data }); 
class RaamiClient { 
  constructor(environment, agentCode, accessKey) {
    this.baseUrl = 'https://rapis.rameeglobalpay.com/v1'; 
    if (!agentCode) throw new Error('agentCode is required');
    if (!accessKey || Buffer.byteLength(accessKey) !== 32) throw new Error('accessKey must be 32 characters');
    this.agentCode = agentCode;
    this.accessKey = accessKey;
    this.timeout = 30000;
  }  
  encrypt(obj) {
    const json = JSON.stringify(obj);
    console.log('[RaamiClient] encrypt: data before encryption:', json);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.accessKey, iv);
    const enc = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const out = Buffer.concat([iv, tag, enc]).toString('base64');
    console.log('[RaamiClient] encrypt: encrypted data (base64):', out);
    console.log('[RaamiClient] encrypt: parts (hex):', {
      iv: iv.toString('hex'), tag: tag.toString('hex'), ciphertext: enc.toString('hex'),
      totalBytes: iv.length + tag.length + enc.length,
    });
    // Self-check: decrypt what we just produced with the same key.
    try {
      const back = this.decryptRaw(out);
      console.log('[RaamiClient] encrypt: self-check decrypt', back === json ? 'OK' : 'MISMATCH', back);
    } catch (e) {
      console.log('[RaamiClient] encrypt: self-check decrypt FAILED:', e.message);
    }
    return out;
  }
  // Decrypts to the plain UTF-8 string (no JSON parsing, no logging).
  decryptRaw(text) {
    const buf = Buffer.from(text, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.accessKey, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  }
  decrypt(text) {
    console.log('[RaamiClient] decrypt: encrypted data before decryption (base64):', text);
    let plain;
    try {
      plain = this.decryptRaw(text);
    } catch (e) {
      console.log('[RaamiClient] decrypt: FAILED:', e.message);
      throw e;
    }
    console.log('[RaamiClient] decrypt: decrypted data (raw string):', plain);
    const parsed = JSON.parse(plain);
    console.log('[RaamiClient] decrypt: data after decryption (parsed):', parsed);
    return parsed;
  }
  request(method, path, payload = {}) {
    const url = new URL(this.baseUrl + path);
    // Docs: agent code goes in the X-Agent-Code header; `data` is the only body field.
    const body = JSON.stringify({ data: this.encrypt(payload) });
    console.log(`[RaamiClient] ${method} ${url.href} request:`, {
      headers: { 'Content-Type': 'application/json', 'X-Agent-Code': this.agentCode },
      body,
    });
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve) => {
      const req = lib.request(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Agent-Code': this.agentCode,
        },
        timeout: this.timeout,
      }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          console.log(`[RaamiClient] ${method} ${url.href} full response:`, {
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            httpVersion: res.httpVersion,
            headers: res.headers,
            body: raw,
          });
          let out;
          try { out = JSON.parse(raw); } catch (e) {
            return resolve(result(false, res.statusCode, 'Invalid response from server.'));
          } 
          if (out && typeof out.data === 'string') {
            try { out = this.decrypt(out.data); } catch (e) { /* not ciphertext, keep as is */ }
          }
          const { success, message, ...data } = out || {}; 
          const ok = res.statusCode < 400 && success !== false;
          resolve(result(ok, res.statusCode, message || (ok ? 'Success' : `Request failed (HTTP ${res.statusCode})`), Object.keys(data).length ? data : null));
        });
      });
      req.on('timeout', () => req.destroy(new Error(`Request timed out after ${this.timeout}ms`)));
      req.on('error', (e) => console.log(`[RaamiClient] ${method} ${path} request error:`, e));
      req.on('error', (e) => resolve(result(false, 0, e.message || e.code || 'Network error')));
      req.end(body);
    });
  } 
  /** Pay-in: { currency, amount, orderid?, rurl?, note? }. orderid is generated when left out. data: { url, orderid, merchantid } */
  createOrder({ orderid = newOrderId(), ...params }) { return this.request('POST', '/order/generate', { ...params, orderid }); }

  /** Pay-in status: orderid = your order id or our txn id */
  getOrderStatus(orderid) { return this.request('POST', '/order/status', { orderid }); }

  /** Wallet balance */
  getBalance() { return this.request('GET', '/balance'); } 

  /** Payout methods for a currency */
  getPayoutMethods(currency) { return this.request('POST', '/payout/methods', { currency }); }

  /** Payout: { currency, amount, orderDetail, orderid?, note? }. orderid is generated when left out. orderDetail fields depend on currency/method */
  createPayout({ orderid = newOrderId(), ...params }) { return this.request('POST', '/payout/request', { ...params, orderid }); }

  /** Payout status */
  getPayoutStatus(orderid) { return this.request('POST', '/payout/status', { orderid }); }
}

// alphanumeric, 20 chars: fits both the pay-in (4-35) and payout (10-45) limits
const newOrderId = () =>  Date.now() + crypto.randomBytes(5).toString('hex').toUpperCase();
const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

module.exports = { RaamiClient };
