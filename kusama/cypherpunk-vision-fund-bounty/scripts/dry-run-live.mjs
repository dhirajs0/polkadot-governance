// node dry-run-live.mjs <proxy.proxy call hex> <spawner address>   (needs: npm i and the fork from kah.yml)
// Dry-runs the spawner's exact addProxy(W3F) call on a fork, then previews funding, acceptance and the spawner's removal with the real pure.
import { ApiPromise, WsProvider } from '@polkadot/api';
import { blake2AsHex } from '@polkadot/util-crypto';
import { stringToHex } from '@polkadot/util';
const CALL = process.argv[2], SPAWNER = process.argv[3];
const W3F = 'EFuprYL5sShF5qao4F9hVRrkbutFeoAgn4HHehq4Rkx3ahm';
const provider = new WsProvider('ws://127.0.0.1:8011');
const api = await ApiPromise.create({ provider, noInitWarn: true });
const log = console.log, human = (x) => JSON.stringify(x.toHuman());
let fails = 0;
function report(evs, label, expectFail = false) {
  let ok = true;
  for (const { event: e } of evs) {
    if (e.section === 'system' && e.method === 'ExtrinsicFailed') { ok = false; const d = e.data[0].isModule ? api.registry.findMetaError(e.data[0].asModule) : null; log(`   x ExtrinsicFailed ${d ? d.section + '.' + d.name : e.data[0]}`); }
    else if (['proxy', 'multiAssetBounties', 'scheduler', 'balances'].includes(e.section) && !['Withdraw', 'Deposit', 'Endowed'].includes(e.method)) {
      const res = e.data.result ?? (e.method === 'Dispatched' ? e.data[2] : undefined);
      let extra = ''; if (res && res.isErr) { ok = false; const d = res.asErr.isModule ? api.registry.findMetaError(res.asErr.asModule) : null; extra = ` => inner error ${d ? d.section + '.' + d.name : res.asErr}`; }
      log(`   . ${e.section}.${e.method} ${human(e.data)}${extra}`);
    }
  }
  const pass = ok !== expectFail; if (!pass) fails++; log(`   ${pass ? 'PASS' : 'FAIL'}: ${label}`); return evs;
}
async function send(tx, signer, label, expectFail) {
  const nonce = await api.rpc.system.accountNextIndex(signer);
  tx.signFake(signer, { nonce, genesisHash: api.genesisHash, runtimeVersion: api.runtimeVersion, blockHash: api.genesisHash });
  const sig = new Uint8Array(64).fill(0xcd); sig.set([0xde, 0xad, 0xbe, 0xef]); tx.signature.set(sig);
  return new Promise((res, rej) => tx.send(async ({ status }) => { if (status.isInBlock) res(report(await api.query.system.events.at(status.asInBlock), label, expectFail)); }).catch(rej));
}
const call = api.createType('Call', CALL);
const PURE = call.toHuman().args.real.Id;
log(`fork head #${(await api.rpc.chain.getHeader()).number}, pure ${PURE}, signer ${SPAWNER}`);
log('\n[1] submit the exact call bytes as the spawner');
await send(api.tx(call), SPAWNER, 'addProxy(W3F, Any) via proxy.proxy');
const [defs, dep] = await api.query.proxy.proxies(PURE);
log('   proxies', human(defs), 'deposit', dep.toString());
log('   pure account', human((await api.query.system.account(PURE)).data));
log('\n[2] W3F (mock signature) can now act as the pure');
await send(api.tx.proxy.proxy(PURE, null, api.tx.system.remarkWithEvent(stringToHex('w3f ok'))), W3F, 'W3F acts as the pure');
log('\n[3] preview: enact fund_bounty as Treasurer with the real pure as curator');
const META = blake2AsHex('CYPHERPUNK VISION FUND');
if ((await api.query.preimage.requestStatusFor(META)).isNone) await send(api.tx.preimage.notePreimage(stringToHex('CYPHERPUNK VISION FUND')), SPAWNER, 'note metadata (fork only)');
const AK = { V5: { location: { parents: 0, interior: 'Here' }, assetId: { parents: 2, interior: { X1: [{ GlobalConsensus: 'Polkadot' }] } } } };
const fund = api.tx.multiAssetBounties.fundBounty(AK, 1599200000000000n, PURE, META).method;
log(`   fund_bounty call ${fund.toHex()}`);
const relay = (await api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber();
await provider.send('dev_setStorage', [{ Scheduler: { Agenda: [[[relay + 1], [{ maybeId: null, priority: 0, call: { Inline: fund.toHex() }, maybePeriodic: null, origin: { Origins: 'Treasurer' } }]]] } }]);
let idx = null;
for (let i = 0; i < 4 && idx === null; i++) {
  const evs = await api.query.system.events.at(await provider.send('dev_newBlock', [{ count: 1 }]));
  if (evs.some(({ event }) => event.method === 'Dispatched')) { report(evs.filter(({ event }) => event.section !== 'balances'), 'fund_bounty as Treasurer'); const c = evs.find(({ event }) => event.method === 'BountyCreated'); idx = c ? c.event.data.index.toNumber() : -1; }
}
if (idx >= 0) {
  await send(api.tx.multiAssetBounties.checkStatus(idx, null), SPAWNER, 'check_status');
  log('\n[4] W3F accepts the curator role for the pure');
  await send(api.tx.proxy.proxy(PURE, null, api.tx.multiAssetBounties.acceptCurator(idx, null)), W3F, 'accept_curator via W3F');
  log('   bounty', human(await api.query.multiAssetBounties.bounties(idx)));
  log('   pure account', human((await api.query.system.account(PURE)).data));
}
log('\n[5] preview: spawner removes itself');
await send(api.tx.proxy.proxy(PURE, null, api.tx.proxy.removeProxy(SPAWNER, 'Any', 0)), SPAWNER, 'removeProxy(spawner)');
log('   proxies', human((await api.query.proxy.proxies(PURE))[0]));
log(`\n${fails ? fails + ' FAILED' : 'ALL CHECKS PASSED'}`);
await api.disconnect(); process.exit(fails ? 1 : 0);
