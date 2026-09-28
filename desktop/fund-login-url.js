'use strict';

function validateFundLoginUrl(raw, gatewayUrl = process.env.AIJIJIN_GATEWAY_URL) {
  let target;
  try { target = new URL(String(raw || '')); }
  catch { throw new Error('扫码授权页地址无效。'); }
  let gatewayHost = 'trade.5ifund.com';
  try {
    if (gatewayUrl) gatewayHost = new URL(gatewayUrl).hostname.toLowerCase();
  } catch {}
  const host = target.hostname.toLowerCase().replace(/\.$/, '');
  if (target.protocol !== 'https:' || target.username || target.password || (target.port && target.port !== '443') ||
      !(host === gatewayHost || host === '5ifund.com' || host.endsWith('.5ifund.com'))) {
    throw new Error('扫码授权页不是受信任的同花顺地址。');
  }
  return target.toString();
}

module.exports = { validateFundLoginUrl };
