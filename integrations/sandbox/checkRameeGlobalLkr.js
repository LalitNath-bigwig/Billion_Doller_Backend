const { createLkrClient } = require("../../utils/rameeGlobalLkrClient");

async function checkRameeGlobalLkr(config) {
  const methods = await createLkrClient(config).listPayoutMethods();
  return { currency: "LKR", methodCount: new Set(methods.map(method => method.code)).size };
}

if (require.main === module) {
  checkRameeGlobalLkr({
    baseUrl: process.env.RAMEE_GLOBAL_LKR_API_BASE,
    agentCode: process.env.RAMEE_GLOBAL_LKR_AGENT_CODE,
    accessKey: process.env.RAMEE_GLOBAL_LKR_ACCESS_KEY,
  }).then(({ currency, methodCount }) => {
    console.log(`${currency} payout methods returned: ${methodCount}`);
    if (methodCount === 0) process.exitCode = 1;
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { checkRameeGlobalLkr };
