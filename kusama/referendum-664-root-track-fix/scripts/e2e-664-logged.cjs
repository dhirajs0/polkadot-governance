// Logged end-to-end rehearsal of the ref-664 fix on a Chopsticks fork of Kusama Asset Hub.
// Same steps and checks as e2e-664.cjs, plus an evidence bundle in LOGDIR:
//   blocks.jsonl          every block built: number, hash, relay parent, all events
//   snapshots.json        referenda/whitelist/scheduler state at each step
//   transition-block.json the enactment block (B): header, extrinsics, all events
//   checks.json           every check with PASS/FAIL
// Usage: node e2e-664-logged.cjs <deps-api dir> <ws endpoint> <log dir>
const [DEPS, WS, LOGDIR] = process.argv.slice(2);
const fs = require('fs');
const path = require('path');
const { ApiPromise, WsProvider, Keyring } = require(`${DEPS}/node_modules/@polkadot/api`);
const { blake2AsHex, cryptoWaitReady } = require(`${DEPS}/node_modules/@polkadot/util-crypto`);
const { hexToU8a } = require(`${DEPS}/node_modules/@polkadot/util`);

const SUBMIT = '0x5c005d0d01185e035c060000010a000000'; // referenda.submit(WhitelistedCaller, Inline(0x5e035c060000), After(10))
const PROPOSAL = '0x5e035c060000';                     // whitelist.dispatch_whitelisted_call_with_preimage(one_fewer_deciding(0))
const INNER = '0x5c060000';                            // referenda.one_fewer_deciding(0)
const HASH = blake2AsHex(hexToU8a(INNER), 256);
const KSM = 10n ** 12n;

fs.mkdirSync(LOGDIR, { recursive: true });
const out = (f) => path.join(LOGDIR, f);
fs.writeFileSync(out('blocks.jsonl'), '');
const snapshots = [], checks = [];
const provider = new WsProvider(WS, 2500, {}, 300000);
let api, idx = null, enact = null;

const relayNow = async () => (await api.query.parachainSystem.lastRelayChainBlockNumber()).toNumber();
const header = async () => api.rpc.chain.getHeader();
const evJson = (records) => records.map(({ phase, event }) => ({ phase: phase.toString(), section: event.section, method: event.method, data: event.data.toHuman() }));

async function logBlock(tag) {
  const h = await header();
  const rec = { tag, number: h.number.toNumber(), hash: h.hash.toHex(), parentHash: h.parentHash.toHex(), relayParent: await relayNow(),
    events: evJson(await api.query.system.events()) };
  fs.appendFileSync(out('blocks.jsonl'), JSON.stringify(rec) + '\n');
  return rec;
}
async function newBlock(tag = 'advance', params = {}) {
  await provider.send('dev_newBlock', [{ count: 1, ...params }]);
  return logBlock(tag);
}
function check(name, ok) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}`);
  checks.push({ name, result: ok ? 'PASS' : 'FAIL' });
  if (!ok) process.exitCode = 1;
  fs.writeFileSync(out('checks.json'), JSON.stringify(checks, null, 2));
  return ok;
}
async function snap(label) {
  const h = await header();
  const info664 = (await api.query.referenda.referendumInfoFor(664)).unwrap();
  const s = info664.asOngoing;
  const snapRec = {
    label, block: h.number.toNumber(), hash: h.hash.toHex(), relay: await relayNow(),
    decidingCount: { 0: (await api.query.referenda.decidingCount(0)).toNumber(), 1: (await api.query.referenda.decidingCount(1)).toNumber() },
    trackQueue0: (await api.query.referenda.trackQueue(0)).toHuman(),
    referendum664: info664.toHuman(),
    fixReferendum: idx === null ? null : { index: idx, info: (await api.query.referenda.referendumInfoFor(idx)).toHuman() },
    whitelistedCall: { hash: HASH, present: (await api.query.whitelist.whitelistedCall(HASH)).isSome },
    enactmentAgenda: enact === null ? null : { relayBlock: enact, entries: (await api.query.scheduler.agenda(enact)).toHuman() },
  };
  snapshots.push(snapRec);
  fs.writeFileSync(out('snapshots.json'), JSON.stringify(snapshots, null, 2));
  console.log(`  [${label}] block ${snapRec.block} relay=${snapRec.relay} DecidingCount(0)=${snapRec.decidingCount[0]} TrackQueue(0)=${JSON.stringify(snapRec.trackQueue0)} 664 inQueue=${s.inQueue.toJSON()} deciding=${JSON.stringify(s.deciding.toJSON())}`);
  return { dc0: snapRec.decidingCount[0], q0: (await api.query.referenda.trackQueue(0)).map(([i]) => i.toNumber()), s };
}
async function send(tx, who, tag) {
  await tx.signAndSend(who, { nonce: -1 });
  const rec = await newBlock(tag);
  const failed = rec.events.find((e) => e.section === 'system' && e.method === 'ExtrinsicFailed');
  if (failed) throw new Error(`${tx.method.section}.${tx.method.method} failed: ${JSON.stringify(failed.data)}`);
  return rec.events;
}
const show = (evs, sections = ['referenda', 'whitelist', 'scheduler', 'messageQueue', 'convictionVoting']) =>
  evs.filter((e) => sections.includes(e.section)).forEach((e) => console.log(`  event ${e.section}.${e.method} ${JSON.stringify(e.data).slice(0, 180)}`));

(async () => {
  await cryptoWaitReady();
  api = await ApiPromise.create({ provider, noInitWarn: true });
  const alice = new Keyring({ type: 'sr25519', ss58Format: 2 }).addFromUri('//Alice');
  const start = await header();
  const meta = { startedAt: new Date().toISOString(), endpoint: WS, forkedFrom: 'wss://kusama-asset-hub-rpc.polkadot.io',
    runtime: `${api.runtimeVersion.specName} v${api.runtimeVersion.specVersion}`, forkHead: { number: start.number.toNumber(), hash: start.hash.toHex() },
    testAccount: alice.address, calls: { submit: SUBMIT, proposal: PROPOSAL, inner: INNER, whitelistHash: HASH } };
  fs.writeFileSync(out('run-meta.json'), JSON.stringify(meta, null, 2));
  console.log(`fork ${meta.runtime} head ${meta.forkHead.number} ${meta.forkHead.hash} | test account ${alice.address}`);

  await provider.send('dev_setStorage', [{ System: { Account: [[[alice.address], { providers: 1, data: { free: (20_000_000n * KSM).toString() } }]] } }]);
  await newBlock('fund-test-account');

  console.log('\n== 0. Pre-state');
  const p = await snap('0-pre-state');
  check('664 queued behind the phantom slot', p.dc0 === 1 && p.q0.join() === '664' && p.s.inQueue.isTrue);

  console.log('\n== 1. Submit the prepared call (exact bytes)');
  const sub = api.tx(api.createType('Call', SUBMIT));
  console.log(`  decoded: ${JSON.stringify(sub.method.toHuman())}`);
  idx = (await api.query.referenda.referendumCount()).toNumber();
  const e1 = await send(sub, alice, 'submit');
  show(e1);
  const submitted = e1.find((e) => e.section === 'referenda' && e.method === 'Submitted');
  check(`referendum ${idx} submitted on track 1 with proposal ${PROPOSAL}`,
    !!submitted && submitted.data.index.replace(/,/g, '') === String(idx) && submitted.data.track === '1' && submitted.data.proposal.Inline === PROPOSAL);
  await snap('1-after-submit');

  console.log('\n== 2. Decision deposit');
  const e2 = await send(api.tx.referenda.placeDecisionDeposit(idx), alice, 'decision-deposit');
  show(e2);
  check('decision deposit placed', e2.some((e) => e.section === 'referenda' && e.method === 'DecisionDepositPlaced'));

  console.log('\n== 3. Fellowship whitelists the hash via XCM from the relay (DMP, origin Plurality{Technical, Voice})');
  const wl = api.tx.whitelist.whitelistCall(HASH);
  const msg = api.createType('XcmVersionedXcm', { V5: [
    { DescendOrigin: { X1: [{ Plurality: { id: 'Technical', part: 'Voice' } }] } },
    { UnpaidExecution: { weightLimit: 'Unlimited', checkOrigin: null } },
    { Transact: { originKind: 'Xcm', fallbackMaxWeight: null, call: { encoded: wl.method.toHex() } } },
  ] });
  fs.writeFileSync(out('fellowship-xcm.json'), JSON.stringify({ whitelistCall: wl.method.toHex(), xcm: msg.toHuman(), encoded: msg.toHex() }, null, 2));
  const r3 = await newBlock('fellowship-xcm', { dmp: [{ sentAt: await relayNow(), msg: msg.toHex() }] });
  show(r3.events);
  const processed = r3.events.find((e) => e.section === 'messageQueue' && e.method === 'Processed');
  check('downward XCM processed successfully', !!processed && processed.data.success === true);
  check(`WhitelistedCall(${HASH.slice(0, 10)}…) set by the Fellowship XCM`, (await api.query.whitelist.whitelistedCall(HASH)).isSome);
  await snap('3-after-whitelist');

  console.log('\n== 4. Vote aye');
  show(await send(api.tx.convictionVoting.vote(idx, { Standard: { vote: { aye: true, conviction: 'None' }, balance: (15_000_000n * KSM).toString() } }), alice, 'vote'));

  console.log(`\n== 5. Advance blocks until referendum ${idx} is approved and its enactment is scheduled`);
  for (let i = 0; i < 600 && enact === null; i++) {
    const rec = await newBlock('advance');
    for (const e of rec.events) if (e.section === 'referenda' && e.data.index && e.data.index.replace(/,/g, '') === String(idx)) console.log(`  block ${rec.number} relay ${rec.relayParent}: referenda.${e.method}`);
    const info = (await api.query.referenda.referendumInfoFor(idx)).unwrap();
    if (info.isApproved) {
      for (const [k, v] of await api.query.scheduler.agenda.entries())
        if (v.some((x) => x.isSome && x.unwrap().call.isInline && x.unwrap().call.asInline.toHex() === PROPOSAL)) enact = k.args[0].toNumber();
    }
  }
  check(`referendum ${idx} approved; enactment scheduled at relay block ${enact}`, enact !== null);
  await snap('5-approved');

  console.log('\n== 6. Advance to block A: first block whose relay parent reaches the enactment block');
  while ((await relayNow()) < enact) await newBlock('to-block-A');
  const pre = await snap('6-block-A');
  const hA = (await header()).hash.toHex();
  check('664 still queued on block A (scheduler lags one block)', pre.s.inQueue.isTrue && pre.q0.join() === '664');

  console.log('\n== 7. Block B: the enactment');
  const rB = await newBlock('block-B-enactment');
  show(rB.events);
  const blk = await api.rpc.chain.getBlock(rB.hash);
  fs.writeFileSync(out('transition-block.json'), JSON.stringify({
    number: rB.number, hash: rB.hash, parentHash: rB.parentHash, relayParent: rB.relayParent,
    extrinsics: blk.block.extrinsics.map((x) => ({ call: `${x.method.section}.${x.method.method}`, signed: x.isSigned })),
    events: rB.events,
  }, null, 2));
  const after = await snap('7-block-B');
  const started = rB.events.find((e) => e.section === 'referenda' && e.method === 'DecisionStarted' && e.data.index === '664');
  const disp = rB.events.find((e) => e.section === 'whitelist' && e.method === 'WhitelistedCallDispatched');
  const sched = rB.events.find((e) => e.section === 'scheduler' && e.method === 'Dispatched' && e.data.task[0].replace(/,/g, '') === String(enact));
  check('scheduler dispatched the enactment task Ok', !!sched && sched.data.result === 'Ok');
  check('whitelisted call dispatched Ok', !!disp && !!disp.data.result.Ok);
  check('Referenda.DecisionStarted { index: 664, track: 0 }', !!started && started.data.track === '0');
  check('664 deciding, queue empty, DecidingCount(0)=1', after.s.deciding.isSome && after.s.inQueue.isFalse && after.q0.length === 0 && after.dc0 === 1);
  check('whitelist entry consumed', !(await api.query.whitelist.whitelistedCall(HASH)).isSome);

  console.log('\n== 8. Rewind to block A and confirm the state reverts');
  await provider.send('dev_setHead', [hA]);
  const back = await snap('8-rewound-to-A');
  check('rewound: 664 queued again', back.s.inQueue.isTrue);

  meta.finishedAt = new Date().toISOString();
  meta.result = checks.every((c) => c.result === 'PASS') ? 'PASS' : 'FAIL';
  meta.fixReferendum = idx; meta.enactmentRelayBlock = enact;
  meta.blockA = { number: pre ? snapshots.find((x) => x.label === '6-block-A').block : null, hash: hA };
  meta.blockB = { number: rB.number, hash: rB.hash };
  fs.writeFileSync(out('run-meta.json'), JSON.stringify(meta, null, 2));
  console.log(`\nRESULT ${meta.result}: ${checks.filter((c) => c.result === 'PASS').length}/${checks.length} checks passed; block B ${rB.number} ${rB.hash}`);
  await api.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
