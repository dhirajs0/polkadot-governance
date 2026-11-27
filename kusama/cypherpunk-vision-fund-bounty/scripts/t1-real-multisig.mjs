// T1 rehearsal with the real addresses on a fork of live Kusama Asset Hub (mock signatures, nothing touches the live chain).
// D4 add the curator multisig as Governance, D5 remove the spawner, enact ref 680's real proposal as Treasurer,
// check_status, the multisig accepts via its Governance proxy, and the Governance filter blocks KSM and proxy changes.
// The multisig signs directly here (mock signature), which gives the same dispatch origin as its final asMulti approval;
// it does not test the signatory set or threshold. D4 and D5 are skipped once they are live.
// Usage: chopsticks --config=kah.yml (port 8011), then node t1-real-multisig.mjs
import { ApiPromise, WsProvider } from '@polkadot/api';
const PURE = 'Cet4JMngBdyWr7Ug6bwp6PG4xZG4EMjSXXnjZC8jJjd8oJr', MS = process.env.MS || 'Hc2YA7NqbYDxbuHy5iEwtR6LuehN9TYoNyRzqD3Dc5w3Jbm';
const SPAWNER = 'JKssqfCAWuENDwzbEQ6mghDGWJq4uJjd7TJjTnmCGbWH8bQ', W3F = 'EFuprYL5sShF5qao4F9hVRrkbutFeoAgn4HHehq4Rkx3ahm';
const REF = 680, KSM = 10n ** 12n;
const provider = new WsProvider(process.env.WS || 'ws://127.0.0.1:8011');
const api = await ApiPromise.create({ provider, noInitWarn: true });
const log = console.log, J = (x) => JSON.stringify(x.toHuman ? x.toHuman() : x);
let failures = 0;
function report(evs, label, expectFail = false) {
  let ok = true;
  for (const { event } of evs) {
    const { section: s, method: m } = event;
    if (s === 'system' && m === 'ExtrinsicFailed') { ok = false; const e = event.data[0]; const d = e.isModule ? api.registry.findMetaError(e.asModule) : null; log(`   x ExtrinsicFailed ${d ? `${d.section}.${d.name}` : e.toString()}`); }
    else if (['proxy', 'multiAssetBounties', 'scheduler', 'foreignAssets'].includes(s)) {
      let line = `   . ${s}.${m} ${J(event.data)}`;
      const res = event.data.result ?? (s === 'scheduler' && m === 'Dispatched' ? event.data[2] : undefined);
      if (res && res.isErr) { ok = false; const e = res.asErr; const d = e.isModule ? api.registry.findMetaError(e.asModule) : null; line += `  => inner error ${d ? `${d.section}.${d.name}` : e.toString()}`; }
      log(line.slice(0, 400));
    }
  }
  const pass = ok !== expectFail; if (!pass) failures++;
  log(`   ${pass ? 'PASS' : 'FAIL'}: ${label}${expectFail ? ' (expected to fail)' : ''}`);
  return { ok, evs };
}
async function send(tx, signer, label, expectFail = false) {
  const nonce = await api.rpc.system.accountNextIndex(signer);
  tx.signFake(signer, { nonce, genesisHash: api.genesisHash, runtimeVersion: api.runtimeVersion, blockHash: api.genesisHash });
  const sig = new Uint8Array(64).fill(0xcd); sig.set([0xde, 0xad, 0xbe, 0xef]); tx.signature.set(sig);
  return new Promise((resolve, reject) => { tx.send(async ({ status }) => { if (status.isInBlock) resolve(report(await api.query.system.events.at(status.asInBlock), label, expectFail)); }).catch(reject); });
}
const proxies = async () => (await api.query.proxy.proxies(PURE))[0].map((d) => `${d.delegate}:${d.proxyType}:${d.delay}`);
const reserved = async (a) => (await api.query.system.account(a)).data.reserved.toBigInt();

log(`chain ${await api.rpc.system.chain()} spec ${api.runtimeVersion.specVersion} head #${(await api.rpc.chain.getHeader()).number}`);
log(`\n[0] live state`); log(`   pure proxies ${(await proxies()).join(' , ')}`);
log(`   multisig ${MS} free ${(await api.query.system.account(MS)).data.free.toBigInt()} planck`);
const r0 = { me: await reserved(SPAWNER), pure: await reserved(PURE) };

log(`\n[D4] spawner adds the multisig as Governance on the pure`);
const d4 = api.tx.proxy.proxy(PURE, null, api.tx.proxy.addProxy(MS, 'Governance', 0));
log(`   call to submit live from ${SPAWNER}:\n   ${d4.method.toHex()}`);
if ((await proxies()).includes(`${MS}:Governance:0`)) log('   already live, skipped'); else await send(d4, SPAWNER, 'D4 addProxy(multisig, Governance, 0)');

log(`\n[D5] spawner removes itself`);
const d5 = api.tx.proxy.proxy(PURE, null, api.tx.proxy.removeProxy(SPAWNER, 'Any', 0));
log(`   call to submit live from ${SPAWNER}:\n   ${d5.method.toHex()}`);
if (!(await proxies()).some((l) => l.startsWith(SPAWNER))) log('   already live, skipped'); else await send(d5, SPAWNER, 'D5 removeProxy(spawner, Any, 0)');
await send(api.tx.proxy.proxy(PURE, null, api.tx.system.remark('0x00')), SPAWNER, 'spawner acts through the pure after removal', true);
const p = await proxies(); const want = [`${W3F}:Any:0`, `${MS}:Governance:0`];
const exact = p.length === 2 && want.every((w) => p.includes(w)); if (!exact) failures++;
log(`   ${exact ? 'PASS' : 'FAIL'}: proxies are exactly W3F Any + multisig Governance -> ${p.join(' , ')}`);
log(`   reserved: spawner ${r0.me} -> ${await reserved(SPAWNER)}, pure ${r0.pure} -> ${await reserved(PURE)}`);

log(`\n[enact] ref ${REF}'s real proposal, dispatched as Treasurer the way referenda does`);
const info = (await api.query.referenda.referendumInfoFor(REF)).unwrap().asOngoing;
const { hash_: h, len } = info.proposal.asLookup;
const CALL = (await api.query.preimage.preimageFor([h, len])).unwrap().toHex();
log(`   proposal ${h.toHex()} (${len} bytes) = ${J(api.createType('Call', CALL))}`.slice(0, 600));
const relay = (await api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber();
await provider.send('dev_setStorage', [{ Scheduler: { Agenda: [[[relay + 1], [{ maybeId: null, priority: 0, call: { Inline: CALL }, maybePeriodic: null, origin: { Origins: 'Treasurer' } }]]] } }]);
let created;
for (let i = 0; i < 4 && !created; i++) {
  const evs = await api.query.system.events.at(await provider.send('dev_newBlock', [{ count: 1 }]));
  if (evs.some(({ event }) => event.section === 'scheduler' && event.method === 'Dispatched')) { report(evs, 'fund_bounty enacts as Treasurer'); created = evs.find(({ event }) => event.method === 'BountyCreated'); }
}
if (!created) { log('   FAIL: no bounty created'); process.exit(1); }
const IDX = created.event.data.index.toNumber(); log(`   bounty index ${IDX}`);

log(`\n[status] anyone calls check_status`);
await send(api.tx.multiAssetBounties.checkStatus(IDX, null), SPAWNER, 'check_status');
log(`   status ${J((await api.query.multiAssetBounties.bounties(IDX)).unwrap().status)}`);

log(`\n[accept] the multisig accepts through its Governance proxy`);
await send(api.tx.proxy.proxy(PURE, 'Governance', api.tx.multiAssetBounties.acceptCurator(IDX, null)), MS, 'multisig: accept_curator');
log(`   status ${J((await api.query.multiAssetBounties.bounties(IDX)).unwrap().status)}`);

log(`\n[filter] the Governance proxy cannot move KSM or change proxies`);
await send(api.tx.proxy.proxy(PURE, 'Governance', api.tx.balances.transferKeepAlive(MS, KSM / 100n)), MS, 'multisig: balances transfer', true);
await send(api.tx.proxy.proxy(PURE, 'Governance', api.tx.proxy.addProxy(SPAWNER, 'Any', 0)), MS, 'multisig: addProxy', true);
await send(api.tx.proxy.proxy(PURE, null, api.tx.system.remark('0x01')), W3F, 'W3F still controls the pure');
log(`\n${failures ? `${failures} check(s) FAILED` : 'ALL CHECKS PASSED'}`);
await api.disconnect(); process.exit(failures ? 1 : 0);
