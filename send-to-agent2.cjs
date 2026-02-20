#!/usr/bin/env node
'use strict';
/**
 * Send an on-chain message from MicroAgent1 to MicroAgent2.
 * Usage: node send-to-agent2.cjs <message>
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const bsv = require('bsv');

const MY_WALLET = path.join(require('os').homedir(), '.openclaw', 'microagent', 'wallet.json');
const AGENT2_ADDR = '1Q6JhJKcDzZrLS8A1z2JTjyGuESfLTdRuX';
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const PREFIX = 'MA1';
const SEND_AMOUNT = 1000;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'microagent/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: parsed.hostname, path: parsed.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const message = process.argv.slice(2).join(' ');
  if (!message) { console.error('Usage: node send-to-agent2.cjs <message>'); process.exit(1); }

  const w = JSON.parse(fs.readFileSync(MY_WALLET, 'utf8'));
  const privKey = bsv.PrivKey.fromWif(w.wif);
  const keyPair = bsv.KeyPair.fromPrivKey(privKey);

  const utxos = await httpGet(`${WOC}/address/${w.address}/unspent`);
  if (!utxos.length) { console.error('No UTXOs'); process.exit(1); }

  const tx = new bsv.Tx();
  const inputTxOuts = [];
  let inputSats = 0;

  for (const u of utxos) {
    const rawHex = await httpGet(`${WOC}/tx/${u.tx_hash}/hex`);
    const prevTx = bsv.Tx.fromHex(typeof rawHex === 'string' ? rawHex : rawHex.hex);
    tx.addTxIn(Buffer.from(u.tx_hash, 'hex').reverse(), u.tx_pos, new bsv.Script(), 0xffffffff);
    inputTxOuts.push(prevTx.txOuts[u.tx_pos]);
    inputSats += u.value;
    if (inputSats > SEND_AMOUNT + 5000) break;
  }

  const opScript = new bsv.Script();
  opScript.writeOpCode(bsv.OpCode.OP_FALSE);
  opScript.writeOpCode(bsv.OpCode.OP_RETURN);
  opScript.writeBuffer(Buffer.from(PREFIX, 'utf8'));
  opScript.writeBuffer(Buffer.from('msg', 'utf8'));
  opScript.writeBuffer(Buffer.from(message, 'utf8'));
  tx.addTxOut(new bsv.Bn(0), opScript);
  tx.addTxOut(new bsv.Bn(SEND_AMOUNT), bsv.Address.fromString(AGENT2_ADDR).toTxOutScript());

  const fee = Math.ceil((200 + message.length + 34 * 2) * 0.5);
  const change = inputSats - SEND_AMOUNT - fee;
  if (change < 0) { console.error('Insufficient funds'); process.exit(1); }
  tx.addTxOut(new bsv.Bn(change), bsv.Address.fromString(w.address).toTxOutScript());

  for (let i = 0; i < inputTxOuts.length; i++) {
    const sig = tx.sign(keyPair, bsv.Sig.SIGHASH_ALL | bsv.Sig.SIGHASH_FORKID, i, inputTxOuts[i].script, inputTxOuts[i].valueBn);
    const scriptSig = new bsv.Script();
    scriptSig.writeBuffer(sig.toTxFormat());
    scriptSig.writeBuffer(keyPair.pubKey.toBuffer());
    tx.txIns[i].setScript(scriptSig);
  }

  const result = await httpPost(`${WOC}/tx/raw`, { txhex: tx.toHex() });
  const txid = Buffer.from(tx.hash()).reverse().toString('hex');
  console.log(`✉️  Agent1 → Agent2`);
  console.log(`To: ${AGENT2_ADDR}`);
  console.log(`Message: "${message}"`);
  console.log(`TXID: ${txid}`);
  console.log(`Fee: ${fee} sats`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
