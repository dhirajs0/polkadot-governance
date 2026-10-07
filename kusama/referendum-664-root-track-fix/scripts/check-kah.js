// node check-kah.js   (needs: npm i @polkadot/api)
// Decodes the referendum call on live Kusama Asset Hub and shows the stuck Root track.
const { ApiPromise, WsProvider } = require('@polkadot/api');
const { blake2AsHex } = require('@polkadot/util-crypto');

const SUBMIT = '0x5c005d0d01185e035c060000010a000000'; // what you sign
const PROPOSAL = '0x5e035c060000';                     // what the referendum enacts
const INNER = '0x5c060000';                            // what the Fellowship whitelists

(async () => {
  const api = await ApiPromise.create({ provider: new WsProvider('wss://kusama-asset-hub-rpc.polkadot.io'), noInitWarn: true });
  const head = await api.rpc.chain.getHeader();
  console.log(`${api.runtimeVersion.specName} v${api.runtimeVersion.specVersion}, block ${head.number}`);

  for (const [name, hex] of [['submit', SUBMIT], ['proposal', PROPOSAL], ['inner', INNER]]) {
    const call = api.createType('Call', hex);
    console.log(`${name}: ${call.section}.${call.method} ${JSON.stringify(call.toHuman().args)}`);
    console.log(`  blake2_256 ${blake2AsHex(call.toU8a(), 256)}`);
  }

  const stored = (await api.query.referenda.decidingCount(0)).toNumber();
  const queue = (await api.query.referenda.trackQueue(0)).map(([i]) => i.toNumber());
  let deciding = 0;
  for (const [, v] of await api.query.referenda.referendumInfoFor.entries()) {
    const info = v.unwrap();
    if (info.isOngoing && info.asOngoing.track.eq(0) && info.asOngoing.deciding.isSome) deciding++;
  }
  console.log(`Root track: DecidingCount(0) = ${stored}, referenda actually deciding = ${deciding}, queue = ${JSON.stringify(queue)}`);
  const r664 = (await api.query.referenda.referendumInfoFor(664)).unwrap();
  if (r664.isOngoing) console.log(`664: inQueue=${r664.asOngoing.inQueue}, deciding=${r664.asOngoing.deciding.isSome ? JSON.stringify(r664.asOngoing.deciding.toJSON()) : "none"}`);
  else console.log(`664: ${r664.type}`);
  await api.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
