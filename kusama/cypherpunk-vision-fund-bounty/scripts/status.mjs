// Read-only status of the Cypherpunk Vision Fund setup on live Kusama Asset Hub.
// Checks the enactment invariants (I1, I3, I4, I5, I7) and projects referendum 680's timeline.
//   node status.mjs                 live chain
//   WS=ws://127.0.0.1:8011 node status.mjs   a Chopsticks fork
import { ApiPromise, WsProvider } from '@polkadot/api';

const PURE = 'Cet4JMngBdyWr7Ug6bwp6PG4xZG4EMjSXXnjZC8jJjd8oJr';
const W3F = 'EFuprYL5sShF5qao4F9hVRrkbutFeoAgn4HHehq4Rkx3ahm';
const MS = 'Hc2YA7NqbYDxbuHy5iEwtR6LuehN9TYoNyRzqD3Dc5w3Jbm';
const SPAWNER = 'JKssqfCAWuENDwzbEQ6mghDGWJq4uJjd7TJjTnmCGbWH8bQ';
const TREASURY = 'F3opxRbN5ZbjJNU511Kj2TLuzFcDq9BGduA9TgiECafpg29';
const DOT = { parents: 2, interior: { X1: [{ GlobalConsensus: 'Polkadot' }] } };
const REF = 680, VALUE = 1_599_200_000_000_000n, CURATOR_DEPOSIT = 166_666_666_500n;

const api = await ApiPromise.create({ provider: new WsProvider(process.env.WS || 'wss://kusama-asset-hub-rpc.polkadot.io'), noInitWarn: true });
const log = console.log;
const relay = (await api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber();
const now = (await api.query.timestamp.now()).toNumber();
const at = (block) => new Date(now + (block - relay) * 6000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
log(`Kusama Asset Hub spec ${api.runtimeVersion.specVersion}, block #${(await api.rpc.chain.getHeader()).number}, relay ${relay}, ${new Date(now).toISOString()}`);

const list = (await api.query.proxy.proxies(PURE))[0].map((d) => `${d.delegate}:${d.proxyType}:${d.delay}`);
const hasMs = list.includes(`${MS}:Governance:0`), hasW3f = list.includes(`${W3F}:Any:0`), hasSpawner = list.some((l) => l.startsWith(SPAWNER));
log(`\nproxies of the pure:\n${list.map((l) => `   ${l}`).join('\n')}`);
log(`I1 ${hasW3f && hasMs && !hasSpawner && list.length === 2 ? 'OK  ' : 'WAIT'} W3F Any ${hasW3f ? 'yes' : 'NO'}, multisig Governance ${hasMs ? 'yes (D4 done)' : 'no (D4 pending)'}, spawner ${hasSpawner ? 'still present (D5 pending)' : 'gone (D5 done)'}`);

const info = await api.query.referenda.referendumInfoFor(REF);
const o = info.unwrap();
if (!o.isOngoing) { log(`\nreferendum ${REF}: ${o.type}`); } else {
  const r = o.asOngoing, p = r.proposal.asLookup;
  const call = api.createType('Call', (await api.query.preimage.preimageFor([p.hash_, p.len])).unwrap());
  const meta = call.args[3].toHex();
  log(`I7 ${r.track.toNumber() === 11 && r.origin.toString().includes('Treasurer') ? 'OK  ' : 'FAIL'} referendum ${REF} on track ${r.track}, origin ${r.origin}`);
  log(`I2 ${call.section === 'multiAssetBounties' && call.args[1].toBigInt() === VALUE && call.args[2].toString() === PURE ? 'OK  ' : 'FAIL'} proposal ${p.hash_.toHex()} = ${call.section}.${call.method}, value ${call.args[1]}, curator ${call.args[2]}`);
  const noted = await api.query.preimage.requestStatusFor(meta);
  log(`I4 ${noted.isSome ? 'OK  ' : 'FAIL'} metadata ${meta} noted`);

  const tr = api.consts.referenda.tracks.find(([id]) => id.eq(r.track))[1];
  const since = r.deciding.unwrap().since.toNumber(), dp = tr.decisionPeriod.toNumber(), cp = tr.confirmPeriod.toNumber(), me = tr.minEnactmentPeriod.toNumber();
  const ayes = r.tally.ayes.toBigInt(), nays = r.tally.nays.toBigInt(), support = r.tally.support.toBigInt();
  const active = (await api.query.balances.totalIssuance()).toBigInt() - (await api.query.balances.inactiveIssuance()).toBigInt();
  const x = Math.min(1, (relay - since) / dp);
  const s = tr.minSupport.asLinearDecreasing, a = tr.minApproval.asReciprocal;
  const supportNeeded = Math.max(s.floor.toNumber(), s.ceil.toNumber() - (s.ceil.toNumber() - s.floor.toNumber()) * x / (s.length.toNumber() / 1e9)) / 1e9;
  const approvalNeeded = (x2) => Number(a.factor.toBigInt()) / 1e9 / (x2 + Number(a.xOffset.toBigInt()) / 1e9) + Number(a.yOffset.toBigInt()) / 1e9;
  const approval = ayes + nays > 0n ? Number(ayes * 1_000_000n / (ayes + nays)) / 1e6 : 0;
  log(`\nreferendum ${REF}: approval ${(approval * 100).toFixed(2)}% (needs ${(approvalNeeded(x) * 100).toFixed(2)}% now, 50% at the end), support ${(Number(support * 10n ** 9n / active) / 1e7).toFixed(7)}% of active issuance (needs ${(supportNeeded * 100).toFixed(2)}% now, 0% at the end)`);
  log(`   confirming: ${r.deciding.unwrap().confirming.isSome ? `yes, ends relay ${r.deciding.unwrap().confirming.unwrap()}` : 'no'}`);
  log(`   decision period ends relay ${since + dp} (${at(since + dp)}). If approval is still >= 50% then, confirmation runs to ${since + dp + cp} (${at(since + dp + cp)}) and enactment is no earlier than ${since + dp + cp + me} (${at(since + dp + cp + me)}).`);
}

const tre = (await api.query.foreignAssets.account(DOT, TREASURY)).unwrap().balance.toBigInt();
log(`I3 ${tre >= VALUE ? 'OK  ' : 'FAIL'} treasury DOT ${tre} planck, ${tre - VALUE} spare after funding`);
const pureFree = (await api.query.system.account(PURE)).data.free.toBigInt(), ed = api.consts.balances.existentialDeposit.toBigInt();
log(`I5 ${pureFree >= CURATOR_DEPOSIT + ed ? 'OK  ' : 'FAIL'} pure free ${pureFree} planck (needs ${CURATOR_DEPOSIT + ed})`);
log(`   multisig ${MS} free ${(await api.query.system.account(MS)).data.free.toBigInt()} planck`);
log(`   multiAssetBounties.bountyCount ${await api.query.multiAssetBounties.bountyCount()} (the next bounty gets this index)`);
await api.disconnect();
process.exit(0);
