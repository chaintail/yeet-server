#!/usr/bin/env node
// Decision (b), gas sponsorship: remove the YEET server signer (key quorum YEET_PRIVY_KEY_QUORUM_ID) from every
// existing user wallet. New wallets are created without it (core/trade/wallet-ensure.mjs) and sign-in no longer adds
// it (login/src.jsx), so this only cleans up wallets made before.
//
//   node ops/remove-yeet-signer.mjs                 plan (default): read-only, lists wallets that still carry the signer
//   YEET_REMOVE_SIGNER_CONFIRM=remove-yeet-signer node ops/remove-yeet-signer.mjs --apply
//                                                   PATCH /v1/wallets/{id} {additional_signers: []} per listed wallet
//
// Reads: STATE_DIR/trade.sqlite (wallets table: account, chain, privy_wallet_id) and the core Privy env
// (PRIVY_APP_ID, PRIVY_APP_SECRET, YEET_PRIVY_AUTHORIZATION_KEY, YEET_PRIVY_KEY_QUORUM_ID). Prints wallet ids
// shortened to 10 characters and account ids, never keys, secrets or full addresses.
//
// Privy constraint (docs.privy.io wallets/update and signers/remove-signers, checked 2026-11-13): changing a wallet's
// signers needs the wallet OWNER's authorization. These wallets are owned by the person, so Privy may refuse the
// server's request (403). The script reports each refusal and changes nothing else. For refused wallets the two
// remaining routes are, in order of preference:
//   1. make the attachment inert: delete YEET_PRIVY_AUTHORIZATION_KEY from the core env and delete or rotate the
//      key quorum in the Privy dashboard; a signer whose key no longer exists cannot sign;
//   2. the person removes it in their own browser session (Privy useSigners().removeSigners, as Folio's
//      wallet-privy revokeSigner does). Not built: sign-in stays as it is (decision (c)).
// Exit code: 0 plan done or every removal accepted; 3 when at least one removal was refused; 2 usage/config.
import path from 'node:path';
import {openTradeDb} from '../connector/core/trade/db.mjs';
import {createPrivyApi,privyConfig} from '../connector/core/trade/privy-api.mjs';
import {signerAttachment} from '../connector/core/trade/signer-privy.mjs';

const apply=process.argv.includes('--apply');
const CONFIRM='remove-yeet-signer';
const short=v=>String(v??'').slice(0,10);

const config=privyConfig(process.env);
const quorum=process.env.YEET_PRIVY_KEY_QUORUM_ID?.trim();
if(!config||!quorum){console.error('needs PRIVY_APP_ID, PRIVY_APP_SECRET, YEET_PRIVY_AUTHORIZATION_KEY and YEET_PRIVY_KEY_QUORUM_ID');process.exit(2)}
if(apply&&process.env.YEET_REMOVE_SIGNER_CONFIRM!==CONFIRM){console.error(`--apply refused: set YEET_REMOVE_SIGNER_CONFIRM=${CONFIRM}`);process.exit(2)}

const db=openTradeDb(path.join(process.env.STATE_DIR||'/state','trade.sqlite'));
const api=createPrivyApi({config,timeoutMs:15_000});
const rows=db.prepare("SELECT account_id,chain,privy_wallet_id FROM wallets WHERE privy_wallet_id IS NOT NULL ORDER BY account_id,chain").all();

const out={mode:apply?'apply':'plan',wallets_checked:0,carrying_signer:[],removed:[],refused:[],read_errors:[]};
for(const r of rows){
 out.wallets_checked++;
 let w;
 try{w=await api.app('GET',`/v1/wallets/${r.privy_wallet_id}`)}
 catch(e){out.read_errors.push({account:r.account_id,chain:r.chain,wallet:short(r.privy_wallet_id),code:e?.code??'READ_FAILED'});continue}
 if(!signerAttachment(w,quorum).granted)continue;
 const ref={account:r.account_id,chain:r.chain,wallet:short(r.privy_wallet_id)};
 out.carrying_signer.push(ref);
 if(!apply)continue;
 const keep=(Array.isArray(w.additional_signers)?w.additional_signers:[]).filter(s=>s?.signer_id!==quorum)
  .map(s=>({signer_id:s.signer_id,...(Array.isArray(s.override_policy_ids)&&s.override_policy_ids.length?{override_policy_ids:s.override_policy_ids}:{})}));
 try{
  const after=await api.signed('PATCH',`/v1/wallets/${r.privy_wallet_id}`,{additional_signers:keep});
  if(signerAttachment(after,quorum).granted)throw Object.assign(Error('still attached'),{code:'STILL_ATTACHED'});
  db.prepare("UPDATE wallets SET signer_state='revoked',updated_at=? WHERE account_id=? AND chain=?").run(Date.now(),r.account_id,r.chain);
  out.removed.push(ref);
 }catch(e){out.refused.push({...ref,code:e?.code??'PATCH_FAILED',status:e?.status??null})}
}
console.log(JSON.stringify(out,null,1));
if(out.refused.length)console.error(`${out.refused.length} removal(s) refused: see the header of this script for the two remaining routes.`);
process.exit(out.refused.length?3:0);
