// Cypherpunk Vision Fund: rehearse the multi-asset bounty setup on a Chopsticks fork of Kusama Asset Hub.
// Needs: npm i (in this folder) and a fork running: npx @acala-network/chopsticks --config=kah.yml (port 8011).
//   node cvf-rehearsal.mjs all     stand-in accounts end to end (create pure -> fund -> accept)
//   node cvf-rehearsal.mjs setup   stand-in pure only; prints PURE
//   PURE=<pure> [CURATORS=<multisig>] [SIGNATORIES=a,b,c THRESHOLD=2] [SPAWNER=<addr>] node cvf-rehearsal.mjs fund
//                                  check a real (or set-up) pure, enact fund_bounty as Treasurer, accept curator
// Every signature is a mock signature, so any real address can sign on the fork. Nothing touches the live chain.
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { createKeyMulti, sortAddresses, encodeAddress, blake2AsHex } from '@polkadot/util-crypto';
import { stringToHex } from '@polkadot/util';

const MODE = process.argv[2] || 'all';
const W3F = process.env.W3F || 'EFuprYL5sShF5qao4F9hVRrkbutFeoAgn4HHehq4Rkx3ahm';
const META = process.env.META || 'CYPHERPUNK VISION FUND';
const VALUE = BigInt(process.env.PLANCK || (159_920n * 10n ** 10n).toString()); // 159,920 DOT x 10^10
const KSM = 10n ** 12n;
const DOT_ID = { parents: 2, interior: { X1: [{ GlobalConsensus: 'Polkadot' }] } };
const ASSET_KIND = { V5: { location: { parents: 0, interior: 'Here' }, assetId: DOT_ID } };
const TREASURY = 'F3opxRbN5ZbjJNU511Kj2TLuzFcDq9BGduA9TgiECafpg29';

const provider = new WsProvider(process.env.WS || 'ws://127.0.0.1:8011');
const api = await ApiPromise.create({ provider, noInitWarn: true });
const kr = new Keyring({ type: 'sr25519', ss58Format: 2 });
const dev = (u) => kr.addFromUri(u).address;
const log = (...a) => console.log(...a);
const human = (x) => JSON.stringify(x.toHuman ? x.toHuman() : x);
const rpc = (m, p) => provider.send(m, p);
let failures = 0;

function report(evs, label, expectFail = false) {
  let ok = true;
  for (const { event } of evs) {
    const { section: s, method: m } = event;
    if (s === 'system' && m === 'ExtrinsicFailed') {
      ok = false; const e = event.data[0]; const d = e.isModule ? api.registry.findMetaError(e.asModule) : null;
      log(`   x ExtrinsicFailed ${d ? `${d.section}.${d.name}` : e.toString()}`);
    } else if (['proxy', 'multisig', 'multiAssetBounties', 'scheduler', 'preimage', 'foreignAssets'].includes(s)) {
      let line = `   . ${s}.${m} ${human(event.data)}`;
      const res = event.data.result ?? (s === 'scheduler' && m === 'Dispatched' ? event.data[2] : undefined);
      if (res && res.isErr) { ok = false; const e = res.asErr; const d = e.isModule ? api.registry.findMetaError(e.asModule) : null; line += `  => inner error ${d ? `${d.section}.${d.name}` : e.toString()}`; }
      log(line);
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
  return new Promise((resolve, reject) => {
    tx.send(async ({ status }) => { if (status.isInBlock) resolve(report(await api.query.system.events.at(status.asInBlock), label, expectFail)); }).catch(reject);
  });
}
async function topUp(addrs, amount = 5n * KSM) {
  const entries = [];
  for (const a of addrs) { const acc = await api.query.system.account(a); if (acc.data.free.toBigInt() < amount) entries.push([[a], { nonce: acc.nonce.toNumber(), providers: Math.max(1, acc.providers.toNumber()), consumers: acc.consumers.toNumber(), sufficients: acc.sufficients.toNumber(), data: { free: amount.toString(), reserved: acc.data.reserved.toString(), frozen: acc.data.frozen.toString() } }]); }
  if (entries.length) await rpc('dev_setStorage', [{ System: { Account: entries } }]);
}
async function viaMultisig(msig, signatories, threshold, innerCall, label, expectFail = false) {
  const call = api.tx.proxy.proxy(PURE, null, innerCall).method;
  const maxW = { refTime: 5_000_000_000n, proofSize: 300_000n };
  const signers = signatories.slice(0, threshold);
  let when = null;
  for (let i = 0; i < signers.length; i++) {
    const others = sortAddresses(signatories.filter((a) => a !== signers[i]), 2);
    const last = i === signers.length - 1;
    await send(api.tx.multisig.asMulti(threshold, others, when, call, maxW), signers[i], `${label} (approval ${i + 1}/${threshold})`, last && expectFail);
    if (!last) when = (await api.query.multisig.multisigs(msig, call.hash)).unwrap().when;
  }
}

log(`chain ${await api.rpc.system.chain()} spec ${api.runtimeVersion.specVersion} head #${(await api.rpc.chain.getHeader()).number}`);
let PURE = process.env.PURE;
let SIGNATORIES = process.env.SIGNATORIES ? process.env.SIGNATORIES.split(',').map((s) => s.trim()) : null;
let THRESHOLD = Number(process.env.THRESHOLD || 2);
let CURATORS = process.env.CURATORS || (SIGNATORIES ? encodeAddress(createKeyMulti(SIGNATORIES, THRESHOLD), 2) : null);
let SPAWNER = process.env.SPAWNER || null;

if (MODE === 'setup' || MODE === 'all') {
  SPAWNER = dev('//Alice');
  SIGNATORIES = ['//Bob', '//Charlie', '//Dave'].map(dev); THRESHOLD = 2;
  CURATORS = encodeAddress(createKeyMulti(SIGNATORIES, THRESHOLD), 2);
  await topUp([SPAWNER, ...SIGNATORIES], 20n * KSM);
  log('\n[1] spawner creates the pure: proxy.createPure(Any, 0, 0)');
  const r = await send(api.tx.proxy.createPure('Any', 0, 0), SPAWNER, 'createPure');
  const ev = r.evs.find(({ event }) => event.method === 'PureCreated').event;
  PURE = ev.data.pure.toString();
  log(`   PURE=${PURE}  (keep: who, disambiguationIndex, at, extrinsicIndex for killPure)`);
  log('\n[2] fund the pure with 0.5 KSM');
  await send(api.tx.balances.transferKeepAlive(PURE, KSM / 2n), SPAWNER, 'fund pure');
  log('\n[3] add W3F as Any (spawner acting as the pure)');
  await send(api.tx.proxy.proxy(PURE, null, api.tx.proxy.addProxy(W3F, 'Any', 0)), SPAWNER, 'add W3F Any');
  log(`\n[4] add curator multisig ${CURATORS} as Governance`);
  await send(api.tx.proxy.proxy(PURE, null, api.tx.proxy.addProxy(CURATORS, 'Governance', 0)), SPAWNER, 'add curators Governance');
  log('\n[5] spawner removes itself');
  await send(api.tx.proxy.proxy(PURE, null, api.tx.proxy.removeProxy(SPAWNER, 'Any', 0)), SPAWNER, 'remove spawner');
  log('\n[6] spawner can no longer act');
  await send(api.tx.proxy.proxy(PURE, null, api.tx.system.remark('0x00')), SPAWNER, 'spawner acts after removal', true);
  if (MODE === 'setup') { log(`\nPURE=${PURE} CURATORS=${CURATORS} SIGNATORIES=${SIGNATORIES.join(',')} THRESHOLD=2 SPAWNER=${SPAWNER}`); await api.disconnect(); process.exit(failures ? 1 : 0); }
}

if (!PURE) { log('set PURE=<pure address> for fund mode'); process.exit(2); }
log(`\n[check] proxies of the pure ${PURE}`);
const [defs] = await api.query.proxy.proxies(PURE);
const list = defs.map((d) => `${d.delegate.toString()}:${d.proxyType.toString()}:${d.delay.toString()}`);
list.forEach((l) => log(`   ${l}`));
const expect = [`${W3F}:Any:0`, ...(CURATORS ? [`${CURATORS}:Governance:0`] : [])];
const exact = expect.every((e) => list.includes(e)) && list.length === expect.length;
const noSpawner = !SPAWNER || !list.some((l) => l.startsWith(SPAWNER));
log(`   ${exact && noSpawner ? 'PASS' : 'FAIL'}: proxies are exactly ${expect.join(' + ')}${SPAWNER ? ' and the spawner is gone' : ''}`);
if (!(exact && noSpawner)) failures++;
const pureFree = (await api.query.system.account(PURE)).data.free.toBigInt();
log(`   pure free balance ${pureFree} planck (needs > 166666666500 curator deposit + ED)`);

log(`\n[meta] metadata preimage "${META}" -> ${blake2AsHex(META)}`);
const META_HASH = blake2AsHex(META);
if ((await api.query.preimage.requestStatusFor(META_HASH)).isNone) { await topUp([dev('//Eve')]); await send(api.tx.preimage.notePreimage(stringToHex(META)), dev('//Eve'), 'note metadata (fork only)'); } else log('   already noted');

const fund = api.tx.multiAssetBounties.fundBounty(ASSET_KIND, VALUE, PURE, META_HASH).method;
log(`\n[fund] fund_bounty call (${fund.toU8a().length} bytes) ${fund.toHex()}`);
log(`   value ${VALUE} planck = ${Number(VALUE) / 1e10} DOT; native check = value x AssetRate`);
const before = (await api.query.foreignAssets.account(DOT_ID, TREASURY)).unwrap().balance.toBigInt();
log(`   treasury DOT before: ${before} planck`);
async function enactAs(track, expectFail) {
  const relay = (await api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber();
  await rpc('dev_setStorage', [{ Scheduler: { Agenda: [[[relay + 1], [{ maybeId: null, priority: 0, call: { Inline: fund.toHex() }, maybePeriodic: null, origin: { Origins: track } }]]] } }]);
  for (let i = 0; i < 4; i++) {
    const evs = await api.query.system.events.at(await rpc('dev_newBlock', [{ count: 1 }]));
    if (evs.some(({ event }) => event.method === 'Dispatched')) return report(evs, `enact fund_bounty with origin ${track}`, expectFail);
  }
  failures++; log(`   FAIL: ${track} never dispatched`);
}
await enactAs('BigSpender', true);
const r = await enactAs('Treasurer', false);
const created = r?.evs.find(({ event }) => event.method === 'BountyCreated');
if (!created) { log('\nno bounty created; stopping'); await api.disconnect(); process.exit(1); }
const IDX = created.event.data.index.toNumber();
const after = (await api.query.foreignAssets.account(DOT_ID, TREASURY)).unwrap().balance.toBigInt();
log(`   bounty index ${IDX}; treasury DOT ${before} -> ${after}`);

log('\n[status] anyone calls check_status');
await topUp([dev('//Ferdie')]);
await send(api.tx.multiAssetBounties.acceptCurator(IDX, null), W3F, 'accept_curator before check_status', true);
await send(api.tx.multiAssetBounties.checkStatus(IDX, null), dev('//Ferdie'), 'check_status');
log(`   status ${human((await api.query.multiAssetBounties.bounties(IDX)).unwrap().status)}`);

log('\n[accept] the pure accepts the curator role');
if (SIGNATORIES && CURATORS) {
  await topUp(SIGNATORIES);
  await viaMultisig(CURATORS, SIGNATORIES, THRESHOLD, api.tx.multiAssetBounties.acceptCurator(IDX, null), 'curators: accept_curator');
  log('\n[filter] Governance proxy cannot move KSM out of the pure');
  await viaMultisig(CURATORS, SIGNATORIES, THRESHOLD, api.tx.balances.transferKeepAlive(W3F, KSM / 100n), 'curators: balances transfer', true);
} else {
  await topUp([W3F]);
  await send(api.tx.proxy.proxy(PURE, null, api.tx.multiAssetBounties.acceptCurator(IDX, null)), W3F, 'W3F: accept_curator');
}
log(`   status ${human((await api.query.multiAssetBounties.bounties(IDX)).unwrap().status)}`);
log(`   pure holds ${human(await api.query.balances.holds(PURE))}`);
log(`\n${failures ? `${failures} check(s) FAILED` : 'ALL CHECKS PASSED'}`);
await api.disconnect();
process.exit(failures ? 1 : 0);
