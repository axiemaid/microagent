#!/usr/bin/env node
const fs = require('fs');
const https = require('https');
const bsv = require('bsv');

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const TARGETS = [
  { addr: '13h5H3LSwxJu12J3hu3dQQFQCsrxDMXpsM', name: 'free1' },
  { addr: '19Gd2Ax8PqHLoBc3rcrHp3e6uBMPAC496P', name: 'free2' },
  { addr: '1JDJe3qvoBmKZ64wpTcRBjE4iaft6QzRyH', name: 'free3' },
];
const AMOUNT = 100000; // 100k sats each

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'node' } }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'node' },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function getRawTx(txid) {
  return new Promise((resolve, reject) => {
    https.get(`${WOC}/tx/${txid}/hex`, { headers: { 'User-Agent': 'node' } }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d.trim()));
    }).on('error', reject);
  });
}

async function main() {
  const walletPath = process.env.HOME + '/.openclaw/bsv-wallet.json';
  const wallet = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  
  const privKey = bsv.PrivKey.fromWif(wallet.wif);
  const keyPair = bsv.KeyPair.fromPrivKey(privKey);
  const myAddr = bsv.Address.fromPrivKey(privKey).toString();
  
  console.log('Source address:', myAddr);
  
  // Get UTXOs
  const utxos = await get(`${WOC}/address/${myAddr}/unspent`);
  if (!utxos || !utxos.length) {
    console.error('No UTXOs found!');
    process.exit(1);
  }
  
  const totalIn = utxos.reduce((s, u) => s + u.value, 0);
  console.log(`UTXOs: ${utxos.length}, Total: ${totalIn} sats`);
  
  // Build TX
  const tx = new bsv.Tx();
  const inputTxOuts = [];
  let inputSats = 0;
  const needed = AMOUNT * TARGETS.length + 2000; // 3 outputs + fee buffer
  
  for (const u of utxos) {
    const rawHex = await getRawTx(u.tx_hash);
    const prevTx = bsv.Tx.fromHex(rawHex);
    tx.addTxIn(Buffer.from(u.tx_hash, 'hex').reverse(), u.tx_pos, new bsv.Script(), 0xffffffff);
    inputTxOuts.push(prevTx.txOuts[u.tx_pos]);
    inputSats += u.value;
    if (inputSats > needed) break;
  }
  
  console.log(`Inputs: ${inputSats} sats`);
  
  // Add outputs
  for (const t of TARGETS) {
    const toAddr = bsv.Address.fromString(t.addr);
    tx.addTxOut(new bsv.Bn(AMOUNT), toAddr.toTxOutScript());
    console.log(`  -> ${t.name} (${t.addr}): ${AMOUNT} sats`);
  }
  
  // Change
  const fee = 500;
  const change = inputSats - (AMOUNT * TARGETS.length) - fee;
  if (change < 0) {
    console.error(`Insufficient funds! Need ${AMOUNT * TARGETS.length + fee}, have ${inputSats}`);
    process.exit(1);
  }
  tx.addTxOut(new bsv.Bn(change), bsv.Address.fromString(myAddr).toTxOutScript());
  console.log(`  -> change: ${change} sats, fee: ${fee} sats`);
  
  // Sign
  for (let i = 0; i < inputTxOuts.length; i++) {
    const sig = tx.sign(keyPair, bsv.Sig.SIGHASH_ALL | bsv.Sig.SIGHASH_FORKID, i, inputTxOuts[i].script, inputTxOuts[i].valueBn);
    const scriptSig = new bsv.Script();
    scriptSig.writeBuffer(sig.toTxFormat());
    scriptSig.writeBuffer(keyPair.pubKey.toBuffer());
    tx.txIns[i].setScript(scriptSig);
  }
  
  const hex = tx.toHex();
  const txid = Buffer.from(tx.hash()).reverse().toString('hex');
  console.log(`TX size: ${hex.length / 2} bytes`);
  console.log(`TXID: ${txid}`);
  
  // Broadcast
  const result = await post(`${WOC}/tx/raw`, { txhex: hex });
  console.log('Broadcast result:', JSON.stringify(result));
}

main().catch(e => console.error('ERROR:', e.message, e.stack));
