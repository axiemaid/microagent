#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const bsv = require('bsv');

// === PATHS ===
const HOME = path.join(require('os').homedir(), '.openclaw', 'microagent');
const WALLET_PATH = path.join(HOME, 'wallet.json');
const STATE_PATH = path.join(HOME, 'state.json');
const CONFIG_PATH = path.join(HOME, 'config.json');
const LOG_PATH = path.join(HOME, 'microagent.log');

// === CONFIG ===
const DEFAULT_CONFIG = {
  loopIntervalMs: 60000,
  feeRate: 0.5,
  protocolPrefix: 'MA1',
  ollama: {
    model: 'llama3.2:3b',
    url: 'http://localhost:11434'
  }
};

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  return DEFAULT_CONFIG;
}

const CONFIG = loadConfig();

// === LOGGING ===
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n');
}

// === WALLET ===
function initWallet() {
  if (fs.existsSync(WALLET_PATH)) {
    const data = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
    const privKey = bsv.PrivKey.fromWif(data.wif);
    return { privKey, keyPair: bsv.KeyPair.fromPrivKey(privKey), address: data.address, wif: data.wif };
  }
  const privKey = bsv.PrivKey.fromRandom();
  const keyPair = bsv.KeyPair.fromPrivKey(privKey);
  const address = bsv.Address.fromPubKey(keyPair.pubKey).toString();
  const wallet = { wif: privKey.toWif(), address };
  fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, null, 2));
  log(`NEW WALLET CREATED: ${address}`);
  return { privKey, keyPair, address, wif: wallet.wif };
}

// === STATE ===
function loadState() {
  if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  return { processedTxids: [], lastLoop: null, inbox: [], actions: [], loopCount: 0, conversations: {} };
}
function saveState(state) { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }

// === HTTP ===
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'microagent/1.0' } }, (res) => {
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
    const mod = url.startsWith('https') ? https : http;
    const payload = JSON.stringify(body);
    const req = mod.request({
      hostname: parsed.hostname, port: parsed.port || (url.startsWith('https') ? 443 : 80),
      path: parsed.pathname, method: 'POST',
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

// === WHATSONCHAIN ===
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';

async function getBalance(addr) {
  const d = await httpGet(`${WOC}/address/${addr}/balance`);
  return (d.confirmed || 0) + (d.unconfirmed || 0);
}
async function getUtxos(addr) {
  return await httpGet(`${WOC}/address/${addr}/unspent`) || [];
}
async function getUnconfirmedUtxos(addr) {
  const d = await httpGet(`${WOC}/address/${addr}/unconfirmed/unspent`);
  return d.result || [];
}
async function getTx(txid) {
  return await httpGet(`${WOC}/tx/hash/${txid}`);
}
async function getRawTx(txid) {
  return await httpGet(`${WOC}/tx/${txid}/hex`);
}
async function broadcast(hex) {
  return await httpPost(`${WOC}/tx/raw`, { txhex: hex });
}

// === OP_RETURN PARSING ===
function parseOpReturn(tx) {
  if (!tx.vout) return null;
  for (const out of tx.vout) {
    const asm = out.scriptPubKey?.asm || '';
    if (!asm.includes('OP_RETURN')) continue;
    const hex = out.scriptPubKey?.hex;
    if (!hex) continue;
    try {
      // Parse hex manually — find data pushes after OP_RETURN
      const buf = Buffer.from(hex, 'hex');
      let i = 0;
      // Skip to after OP_RETURN (0x6a) or OP_FALSE OP_RETURN (0x00 0x6a)
      while (i < buf.length) {
        if (buf[i] === 0x6a) { i++; break; }
        i++;
      }
      const parts = [];
      while (i < buf.length) {
        let len = buf[i]; i++;
        if (len === 0) continue;
        if (len === 0x4c) { len = buf[i]; i++; }        // OP_PUSHDATA1
        else if (len === 0x4d) { len = buf.readUInt16LE(i); i += 2; } // OP_PUSHDATA2
        if (i + len > buf.length) break;
        parts.push(buf.slice(i, i + len).toString('utf8'));
        i += len;
      }
      if (parts.length > 0 && parts[0] === CONFIG.protocolPrefix) {
        return parts.slice(1);
      }
    } catch (e) { /* skip */ }
  }
  return null;
}

function getSender(tx) {
  if (!tx.vin || !tx.vin[0]) return null;
  // Try direct addr field first
  if (tx.vin[0].addr) return tx.vin[0].addr;
  // Extract pubkey from scriptSig asm: "<sig> <pubkey>"
  try {
    const asm = tx.vin[0].scriptSig?.asm || '';
    const parts = asm.split(' ').filter(p => !p.startsWith('[') && !p.startsWith('OP_'));
    // Last part should be the pubkey hex (33 bytes compressed = 66 hex chars)
    const pubKeyHex = parts[parts.length - 1];
    if (pubKeyHex && (pubKeyHex.length === 66 || pubKeyHex.length === 130)) {
      const pubKey = bsv.PubKey.fromHex(pubKeyHex);
      return bsv.Address.fromPubKey(pubKey).toString();
    }
  } catch (e) { /* fallback */ }
  return null;
}

function getAmountToAddress(tx, addr) {
  if (!tx.vout) return 0;
  let total = 0;
  for (const out of tx.vout) {
    if ((out.scriptPubKey?.addresses || []).includes(addr)) {
      total += Math.round((out.value || 0) * 1e8);
    }
  }
  return total;
}

// === SEND OP_RETURN TX ===
async function sendOpReturn(wallet, dataStrings) {
  // Gather UTXOs
  let utxos = await getUtxos(wallet.address);
  if (!utxos.length) utxos = await getUnconfirmedUtxos(wallet.address);
  if (!utxos.length) throw new Error('No UTXOs');

  // Fetch raw txs for inputs
  const tx = new bsv.Tx();
  const inputTxOuts = [];
  let inputSats = 0;

  for (const u of utxos) {
    const rawHex = await getRawTx(u.tx_hash);
    const prevTx = bsv.Tx.fromHex(typeof rawHex === 'string' ? rawHex : rawHex.hex || rawHex);
    const txOut = prevTx.txOuts[u.tx_pos];
    const txHashBuf = Buffer.from(u.tx_hash, 'hex').reverse();
    tx.addTxIn(txHashBuf, u.tx_pos, new bsv.Script(), 0xffffffff);
    inputTxOuts.push(txOut);
    inputSats += u.value;
    if (inputSats > 5000) break;
  }

  // Build OP_RETURN output
  const opScript = new bsv.Script();
  opScript.writeOpCode(bsv.OpCode.OP_FALSE);
  opScript.writeOpCode(bsv.OpCode.OP_RETURN);
  for (const s of dataStrings) {
    opScript.writeBuffer(Buffer.from(s, 'utf8'));
  }
  tx.addTxOut(new bsv.Bn(0), opScript);

  // Estimate fee
  const estSize = 150 + (dataStrings.join('').length) + 34; // rough estimate
  const fee = Math.ceil(estSize * CONFIG.feeRate);
  const change = inputSats - fee;
  if (change < 0) throw new Error(`Insufficient funds: have ${inputSats}, need ${fee} for fee`);

  // Change output
  tx.addTxOut(new bsv.Bn(change), bsv.Address.fromString(wallet.address).toTxOutScript());

  // Sign
  for (let i = 0; i < inputTxOuts.length; i++) {
    const sig = tx.sign(
      wallet.keyPair,
      bsv.Sig.SIGHASH_ALL | bsv.Sig.SIGHASH_FORKID,
      i, inputTxOuts[i].script, inputTxOuts[i].valueBn
    );
    const pubKey = wallet.keyPair.pubKey;
    const scriptSig = new bsv.Script();
    scriptSig.writeBuffer(sig.toTxFormat());
    scriptSig.writeBuffer(pubKey.toBuffer());
    tx.txIns[i].setScript(scriptSig);
  }

  const hex = tx.toHex();
  const txid = Buffer.from(tx.hash()).reverse().toString('hex');
  const result = await broadcast(hex);
  return { txid, fee, result };
}

// === OLLAMA ===
async function think(prompt) {
  try {
    const resp = await httpPost(`${CONFIG.ollama.url}/api/generate`, {
      model: CONFIG.ollama.model,
      prompt: '/no_think\n' + prompt, stream: false,
      options: { temperature: 0.7, num_predict: 200 }
    });
    const text = (resp.response || resp.thinking || '').trim();
    return text || null;
  } catch (e) {
    log(`OLLAMA ERROR: ${e.message}`);
    return null;
  }
}

// === CORE LOOP ===
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function loop(wallet, state) {
  state.loopCount++;
  const balance = await getBalance(wallet.address);
  log(`LOOP #${state.loopCount} | Balance: ${balance} sats`);

  if (balance === 0) {
    if (state.loopCount <= 3) log('WAITING FOR FUNDING — send BSV to: ' + wallet.address);
    return;
  }

  // Scan for new transactions
  const confirmed = await getUtxos(wallet.address);
  const unconfirmed = await getUnconfirmedUtxos(wallet.address);
  const allTxids = [...new Set([...confirmed, ...unconfirmed].map(u => u.tx_hash))];
  const newTxids = allTxids.filter(t => !state.processedTxids.includes(t));

  const newMessages = [];
  for (const txid of newTxids) {
    try {
      await sleep(1000); // rate limit — WoC is strict
      const tx = await getTx(txid);
      const opReturn = parseOpReturn(tx);
      const sender = getSender(tx);
      const amount = getAmountToAddress(tx, wallet.address);

      if (opReturn && sender !== wallet.address) {
        const msg = { txid, sender, amount, type: opReturn[0] || 'unknown', data: opReturn.slice(1), time: Date.now() };
        newMessages.push(msg);
        log(`MSG IN: from=${sender} type=${msg.type} data="${msg.data.join(' | ')}"`);
      } else if (amount > 0 && sender && sender !== wallet.address && !opReturn) {
        log(`PAYMENT IN: ${amount} sats from ${sender}`);
      }
      state.processedTxids.push(txid);
    } catch (e) {
      log(`TX ERROR ${txid}: ${e.message}`);
    }
  }

  // Trim state
  if (state.processedTxids.length > 1000) state.processedTxids = state.processedTxids.slice(-500);

  // Respond to messages
  for (const msg of newMessages) {
    if (msg.type === 'msg') {
      const text = msg.data.join(' ');
      const sender = msg.sender || 'unknown';
      log(`THINKING: "${text}" (from: ${sender})`);

      // Initialize conversation history for this sender
      if (!state.conversations) state.conversations = {};
      if (!state.conversations[sender]) state.conversations[sender] = [];

      // Build conversation context
      const history = state.conversations[sender];
      let contextStr = '';
      if (history.length > 0) {
        const recent = history.slice(-6); // last 6 exchanges
        contextStr = '\nConversation history with this sender:\n' +
          recent.map(h => `${h.role}: ${h.text}`).join('\n') + '\n';
      }

      const response = await think(
        `You are MicroAgent, a minimal autonomous agent living on the BSV blockchain. Address: ${wallet.address}. Balance: ${balance} sats. You communicate only through on-chain transactions.\n` +
        contextStr +
        `\nNew message from ${sender}:\n"${text}"\n\n` +
        `Reply briefly (under 100 chars, every byte costs sats). Be direct. Continue the conversation naturally if there's history.`
      );

      if (response && balance > 1000) {
        const reply = response.substring(0, 100);
        log(`REPLYING: "${reply}"`);
        try {
          const r = await sendOpReturn(wallet, [CONFIG.protocolPrefix, 'reply', msg.txid, reply]);
          log(`REPLY TX: ${r.txid} (fee: ${r.fee} sats)`);
          state.actions.push({ type: 'reply', to: sender, replyTo: msg.txid, text: reply, txid: r.txid, time: Date.now() });

          // Store conversation history
          state.conversations[sender].push({ role: 'them', text, time: Date.now() });
          state.conversations[sender].push({ role: 'me', text: reply, time: Date.now() });
          // Keep max 20 entries per sender
          if (state.conversations[sender].length > 20) {
            state.conversations[sender] = state.conversations[sender].slice(-20);
          }
        } catch (e) {
          log(`REPLY ERROR: ${e.message}`);
        }
      } else {
        log(response ? 'BALANCE TOO LOW TO REPLY' : 'LLM UNAVAILABLE');
        // Still record the incoming message even if we can't reply
        if (!state.conversations[sender]) state.conversations[sender] = [];
        state.conversations[sender].push({ role: 'them', text, time: Date.now() });
      }
    }
  }

  state.inbox.push(...newMessages);
  if (state.inbox.length > 100) state.inbox = state.inbox.slice(-50);
  state.lastLoop = Date.now();
  state.lastBalance = balance;
}

// === MAIN ===
async function main() {
  log('='.repeat(50));
  log('MICROAGENT v0.1 STARTING');
  log('='.repeat(50));

  const wallet = initWallet();
  const state = loadState();

  log(`Address: ${wallet.address}`);
  log(`Loop: ${CONFIG.loopIntervalMs / 1000}s | Fee: ${CONFIG.feeRate} sat/byte | LLM: ${CONFIG.ollama.model}`);

  process.on('SIGINT', () => { log('SHUTDOWN'); saveState(state); process.exit(0); });
  process.on('SIGTERM', () => { log('SHUTDOWN'); saveState(state); process.exit(0); });

  while (true) {
    try {
      await loop(wallet, state);
      saveState(state);
    } catch (e) {
      log(`LOOP ERROR: ${e.message}`);
    }
    await sleep(CONFIG.loopIntervalMs);
  }
}

// === CLI ===
const cmd = process.argv[2];
if (cmd === 'init') {
  const w = initWallet();
  console.log(`Address: ${w.address}`);
  console.log('Send BSV to this address to activate.');
} else if (cmd === 'address') {
  if (fs.existsSync(WALLET_PATH)) console.log(JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8')).address);
  else console.log('No wallet. Run: node microagent.cjs init');
} else if (cmd === 'status') {
  if (fs.existsSync(STATE_PATH)) {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    const w = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
    console.log(`Address:  ${w.address}`);
    console.log(`Loops:    ${s.loopCount}`);
    console.log(`Last:     ${s.lastLoop ? new Date(s.lastLoop).toISOString() : 'never'}`);
    console.log(`Balance:  ${s.lastBalance || 0} sats`);
    console.log(`Messages: ${s.inbox.length}`);
    console.log(`Actions:  ${s.actions.length}`);
  } else console.log('Not started yet.');
} else {
  main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
}
