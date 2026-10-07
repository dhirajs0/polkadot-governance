// node check-fellowship.js   (needs: npm i @polkadot/api)
// Dry-runs, on the live Kusama relay, the XCM the Fellowship sends to whitelist the fix. Read-only.
const { ApiPromise, WsProvider } = require('@polkadot/api');

const WHITELIST = '0x5e002889dc24ab38fab7212e6f81adde354da22e3a24fc717dbf660e52e32afecf87'; // KAH whitelist.whitelist_call(hash)

(async () => {
  const api = await ApiPromise.create({ provider: new WsProvider('wss://kusama-rpc.polkadot.io'), noInitWarn: true });
  console.log(`${api.runtimeVersion.specName} v${api.runtimeVersion.specVersion}`);
  const send = api.tx.xcmPallet.send(
    { V5: { parents: 0, interior: { X1: [{ Parachain: 1000 }] } } },
    { V5: [{ UnpaidExecution: { weightLimit: 'Unlimited', checkOrigin: null } }, { Transact: { originKind: 'Xcm', fallbackMaxWeight: null, call: { encoded: WHITELIST } } }] },
  );
  const submit = api.tx.fellowshipReferenda.submit({ Origins: 'Fellows' }, { Inline: send.method.toHex() }, { After: 10 });
  console.log(`fellowshipReferenda.submit ${submit.method.toHex()}`);
  const r = await api.call.dryRunApi.dryRunCall({ Origins: 'Fellows' }, send.method, 5);
  const ok = r.asOk;
  console.log(`dry run: ${ok.executionResult.isOk ? 'Ok' : JSON.stringify(ok.executionResult.toHuman())}`);
  for (const [dest, msgs] of ok.forwardedXcms) {
    console.log(`forwarded to ${JSON.stringify(dest.toHuman())}`);
    for (const m of msgs) console.log(`  ${JSON.stringify(m.toHuman())}`);
  }
  await api.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
