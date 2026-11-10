// node live-check.mjs <proxy.proxy call hex>   (needs: npm i)
// Decodes a proxy.proxy call, then reads the pure's live proxies, balance, and the blocks where it was created and funded.
import { ApiPromise, WsProvider } from '@polkadot/api';
import { encodeAddress } from '@polkadot/util-crypto';
const CALL = process.argv[2];
const api = await ApiPromise.create({ provider: new WsProvider('wss://kusama-asset-hub-rpc.polkadot.io'), noInitWarn: true });
const head = await api.rpc.chain.getHeader();
console.log('head', head.number.toNumber());
const call = api.createType('Call', CALL);
console.log('decoded', JSON.stringify(call.toHuman()));
const PURE = call.toHuman().args.real.Id;
const inner = call.args[2];
console.log('pure', PURE, '| force', call.args[1].toString(), '| inner', inner.section + '.' + inner.method, JSON.stringify(inner.toHuman().args));
console.log('W3F match', inner.toHuman().args.delegate.Id === 'EFuprYL5sShF5qao4F9hVRrkbutFeoAgn4HHehq4Rkx3ahm');
const [defs, dep] = await api.query.proxy.proxies(PURE);
console.log('proxies', JSON.stringify(defs.toHuman()), 'deposit', dep.toString());
console.log('account', JSON.stringify((await api.query.system.account(PURE)).toHuman()));
const spawner = defs[0]?.delegate.toString();
if (spawner) { const [sd] = await api.query.proxy.proxies(spawner); console.log('spawner', spawner, 'account', JSON.stringify((await api.query.system.account(spawner)).data.toHuman()), 'own proxies', JSON.stringify(sd.toHuman())); }
// binary search for the block where Proxies(pure) first appears
const exists = async (n) => { const h = await api.rpc.chain.getBlockHash(n); const at = await api.at(h); return (await at.query.proxy.proxies(PURE))[0].length > 0; };
let lo = head.number.toNumber() - 40000, hi = head.number.toNumber();
try {
  if (await exists(lo)) { console.log('existed before', lo); } else {
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (await exists(mid)) hi = mid; else lo = mid; }
    const h = await api.rpc.chain.getBlockHash(hi);
    const evs = await (await api.at(h)).query.system.events();
    console.log('created in block', hi, h.toHex());
    for (const { event, phase } of evs) if (['proxy', 'balances'].includes(event.section) && /Pure|Transfer|Reserved/.test(event.method)) console.log('  ', phase.toString(), event.section + '.' + event.method, JSON.stringify(event.data.toHuman()));
  }
} catch (e) { console.log('history search failed:', e.message); }
// find the 0.5 KSM transfer: search for the block where free balance first > 0
const freeAt = async (n) => { const at = await api.at(await api.rpc.chain.getBlockHash(n)); return (await at.query.system.account(PURE)).data.free.toBigInt(); };
try {
  let a = hi, b = head.number.toNumber();
  if ((await freeAt(a)) > 0n) console.log('funded in creation block'); else {
    while (b - a > 1) { const m = Math.floor((a + b) / 2); if ((await freeAt(m)) > 0n) b = m; else a = m; }
    const evs = await (await api.at(await api.rpc.chain.getBlockHash(b))).query.system.events();
    console.log('funded in block', b);
    for (const { event } of evs) if (event.section === 'balances' && event.method === 'Transfer' && event.data.to.toString() === PURE) console.log('  ', JSON.stringify(event.data.toHuman()));
  }
} catch (e) { console.log('funding search failed:', e.message); }
await api.disconnect();
