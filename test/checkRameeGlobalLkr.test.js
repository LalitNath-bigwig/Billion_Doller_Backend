const test = require("node:test");
const assert = require("node:assert/strict");
const { checkRameeGlobalLkr } = require("../integrations/sandbox/checkRameeGlobalLkr");
const { createCipher } = require("../integrations/sandbox/rameeGlobalLkrPayin");

const config = {
  baseUrl: "https://ramee.example.invalid/v1/",
  agentCode: "TESTAGENT0000001",
  accessKey: "0123456789abcdef0123456789abcdef",
};

test("merchant check only looks up LKR payout methods, without following redirects", async () => {
  let requests = 0;
  const result = await checkRameeGlobalLkr({
    ...config,
    async fetchImpl(endpoint, options) {
      requests += 1;
      assert.equal(endpoint.href, "https://ramee.example.invalid/v1/payout/methods");
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers["X-Agent-Code"], config.agentCode);
      assert.deepEqual(createCipher(config.accessKey).decrypt(JSON.parse(options.body).data), { currency: "LKR" });
      return Response.json({ success: true, methods: [{ code: "TESTBANK" }, { code: "TESTBANK" }] });
    },
  });
  assert.equal(requests, 1);
  assert.deepEqual(result, { currency: "LKR", methodCount: 1 });
});

test("missing, unsafe, or malformed base URLs fail before any request", async () => {
  const fetchImpl = async () => assert.fail("Request should be blocked before sending headers");
  for (const baseUrl of ["", "http://ramee.example.invalid/v1", "https://ramee.example.invalid/", "https://user@ramee.example.invalid/v1"]) {
    await assert.rejects(checkRameeGlobalLkr({ ...config, baseUrl, fetchImpl }), /HTTPS API base/);
  }
});

test("provider errors do not leak their response body and empty methods remain distinct", async () => {
  const check = fetchImpl => checkRameeGlobalLkr({ ...config, fetchImpl });
  await assert.rejects(check(async () => new Response("sensitive provider message", { status: 403 })), /^Error: RameeGlobalPay request returned HTTP 403\.$/);
  await assert.rejects(check(async () => Response.json({ success: true, methods: [{}] })), /valid code/);
  assert.deepEqual(await check(async () => Response.json({ success: true, methods: [] })), { currency: "LKR", methodCount: 0 });
});

test("the merchant check authenticates encrypted responses and reports an empty LKR methods list", async () => {
  const cipher = createCipher(config.accessKey);
  const check = async data => checkRameeGlobalLkr({
    ...config, fetchImpl: async () => Response.json({ success: true, data }),
  });
  assert.deepEqual(await check(cipher.encrypt({ success: true, methods: [] })), { currency: "LKR", methodCount: 0 });
  const foreignKey = "fedcba9876543210fedcba9876543210";
  await assert.rejects(check(createCipher(foreignKey).encrypt({ success: true, methods: [] })), /Invalid RameeGlobalPay response envelope/);
  await assert.rejects(check(cipher.encrypt({ success: false, methods: [] })), /did not confirm/);
});
