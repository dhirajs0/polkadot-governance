// node build-calls.cjs --pure <addr> [--spawner <addr>] [--curators <addr>] [--meta "CYPHERPUNK VISION FUND"] [--dot 159920] [--after 14400] [--index 3]
// Prints the exact call data for every step. Checked byte for byte against polkadot.js (see README).
/* Pure call encoder for Kusama Asset Hub (spec 2005001). U = polkadotUtil, C = polkadotUtilCrypto. */
const KAH = {
  rate: 25n, // AssetRate DOT -> KSM planck multiplier on 2026-11-10
  tracks: [
    ['SmallTipper', 8333333333250n], ['BigTipper', 33333333333000n], ['SmallSpender', 333333333330000n],
    ['MediumSpender', 3333333333300000n], ['BigSpender', 33333333333000000n], ['Treasurer', 333333333330000000n],
  ],
};
function buildCalls(inp, U, C) {
  const errors = [], warnings = [];
  const hx = (u8) => U.u8aToHex(u8);
  const cat = (...p) => U.u8aConcat(...p.map((x) => (typeof x === 'string' ? U.hexToU8a(x) : x)));
  const cpt = (n) => U.compactToU8a(BigInt(n));
  const u32 = (n) => U.bnToU8a(BigInt(n), { bitLength: 32, isLe: true });
  const acct = (label, addr, required) => {
    addr = (addr || '').trim();
    if (!addr) { if (required) errors.push(`${label} is missing.`); return null; }
    let pk;
    try { pk = C.decodeAddress(addr); } catch (e) { errors.push(`${label} is not a valid address (${e.message}).`); return null; }
    if (pk.length !== 32) { errors.push(`${label} is not a 32-byte account.`); return null; }
    if (!C.checkAddress(addr, 2)[0]) warnings.push(`${label} is not in Kusama format. Same key as ${C.encodeAddress(pk, 2)}; check that is the account you meant.`);
    return pk;
  };
  const amt = String(inp.dot || '').replace(/[,_\s]/g, '');
  let planck = null;
  if (!/^\d+(\.\d{1,10})?$/.test(amt)) errors.push('Amount must be a DOT number with at most 10 decimals.');
  else { const [i, f = ''] = amt.split('.'); planck = BigInt(i) * 10n ** 10n + BigInt(f.padEnd(10, '0')); }
  const pure = acct('Pure proxy (curator)', inp.pure, true);
  const w3f = acct('W3F account', inp.w3f, false);
  const curators = acct('Curator multisig', inp.curators, false);
  const spawner = acct('Spawner (Dhiraj)', inp.spawner, false);
  const meta = U.stringToU8a(inp.meta || '');
  if (!meta.length) errors.push('Metadata text is empty. The pallet needs a noted preimage.');
  const metaHash = C.blake2AsU8a(meta, 256);
  const after = Number(inp.after);
  if (!Number.isInteger(after) || after < 0) errors.push('Enactment delay must be a whole number of relay blocks.');
  const idx = Number(inp.index);
  const out = { errors, warnings, planck, metaHex: hx(meta), metaHash: hx(metaHash), calls: {} };
  if (planck !== null) {
    out.native = planck * KAH.rate;
    out.track = (KAH.tracks.find(([, max]) => out.native <= max) || ['Root only'])[0];
  }
  const proxyWrap = (inner) => cat('0x2a00', '0x00', pure, '0x00', inner);
  const addProxy = (who, type) => cat('0x2a01', '0x00', who, type, u32(0));
  const removeProxy = (who, type) => cat('0x2a02', '0x00', who, type, u32(0));
  out.calls.createPure = '0x2a0400000000000000';
  out.calls.notePreimage = hx(cat('0x0600', cpt(meta.length), meta));
  if (pure && w3f) out.calls.addW3F = hx(proxyWrap(addProxy(w3f, '0x00')));
  if (pure && curators) out.calls.addCurators = hx(proxyWrap(addProxy(curators, '0x07')));
  if (pure && spawner) out.calls.removeSpawner = hx(proxyWrap(removeProxy(spawner, '0x00')));
  if (planck !== null) {
    const amountBytes = cpt(planck);
    out.segments = [
      ['6200', 'MultiAssetBounties (98), fund_bounty (0)', 'call'], ['05', 'asset_kind: VersionedLocatableAsset V5', 'asset'],
      ['0000', 'location: parents 0, Here (this chain)', 'asset'], ['02010902', 'asset_id: parents 2, GlobalConsensus(Polkadot) = DOT', 'asset'],
      [hx(amountBytes).slice(2), `value: compact(${planck}) planck`, 'value'], ['00', 'curator: MultiAddress::Id', 'curator'],
      [pure ? hx(pure).slice(2) : null, 'curator account: the pure proxy (32 bytes)', 'curator'], [hx(metaHash).slice(2), 'metadata: blake2_256 of the metadata text', 'meta'],
    ];
    if (pure && meta.length) {
      const fund = cat('0x6200', '0x05', '0x0000', '0x02010902', amountBytes, '0x00', pure, metaHash);
      out.calls.fundBounty = hx(fund);
      out.fundLen = fund.length;
      out.fundHash = hx(C.blake2AsU8a(fund, 256));
      out.calls.noteFundPreimage = hx(cat('0x0600', cpt(fund.length), fund));
      if (Number.isInteger(after) && after >= 0) out.calls.submit = hx(cat('0x5c00', '0x5d01', '0x01', cpt(fund.length), fund, '0x01', u32(after)));
    }
  }
  if (Number.isInteger(idx) && idx >= 0) {
    out.calls.checkStatus = hx(cat('0x6207', cpt(idx), '0x00'));
    if (pure) out.calls.acceptCurator = hx(proxyWrap(cat('0x6203', cpt(idx), '0x00')));
  }
  return out;
}

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const out = buildCalls({
  pure: arg('pure', ''), spawner: arg('spawner', ''), curators: arg('curators', ''),
  w3f: arg('w3f', 'EFuprYL5sShF5qao4F9hVRrkbutFeoAgn4HHehq4Rkx3ahm'),
  meta: arg('meta', 'CYPHERPUNK VISION FUND'), dot: arg('dot', '159920'), after: arg('after', '14400'), index: arg('index', '3'),
}, require('@polkadot/util'), require('@polkadot/util-crypto'));
for (const e of out.errors) console.log('error:', e);
for (const w of out.warnings) console.log('warning:', w);
if (out.planck !== null) console.log(`value ${out.planck} planck, counts as ${out.native} KSM planck, lowest track ${out.track}`);
console.log(`metadata ${out.metaHex} hash ${out.metaHash}`);
if (out.fundHash) console.log(`fund_bounty preimage hash ${out.fundHash} length ${out.fundLen}`);
for (const [k, v] of Object.entries(out.calls)) console.log(`${k.padEnd(17)} ${v}`);
