#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const bsv = require('bsv');

// === RESOLVE AGENT DIR ===
function resolveAgentDir() {
  const idx = process.argv.indexOf('--agent-dir');
  if (idx !== -1 && process.argv[idx + 1]) {
    return path.resolve(process.argv[idx + 1]);
  }
  // Fallback: current working directory
  return process.cwd();
}

const AGENT_DIR = resolveAgentDir();
const REPO_DIR = path.resolve(__dirname);

const WALLET_PATH = path.join(AGENT_DIR, 'wallet.json');
const STATE_PATH = path.join(AGENT_DIR, 'state.json');
const CONFIG_PATH = path.join(AGENT_DIR, 'config.json');
const LOG_PATH = path.join(AGENT_DIR, 'microagent.log');
const REPO_SKILLS_DIR = path.join(REPO_DIR, 'skills');
const AGENT_SKILLS_DIR = path.join(AGENT_DIR, 'skills');

// === SKILLS ===
function loadSkills() {
  const skills = [];
  const loaded = new Set();

  // Load from agent-specific skills dir first (overrides)
  if (fs.existsSync(AGENT_SKILLS_DIR)) {
    for (const file of fs.readdirSync(AGENT_SKILLS_DIR)) {
      if (!file.endsWith('.cjs')) continue;
      try {
        const skill = require(path.join(AGENT_SKILLS_DIR, file));
        skills.push(skill);
        loaded.add(file);
      } catch (e) {
        console.error(`Failed to load agent skill ${file}: ${e.message}`);
      }
    }
  }

  // Load from repo skills dir (skip if already loaded from agent dir)
  if (fs.existsSync(REPO_SKILLS_DIR)) {
    for (const file of fs.readdirSync(REPO_SKILLS_DIR)) {
      if (!file.endsWith('.cjs') || loaded.has(file)) continue;
      try {
        const skill = require(path.join(REPO_SKILLS_DIR, file));
        skills.push(skill);
      } catch (e) {
        console.error(`Failed to load skill ${file}: ${e.message}`);
      }
    }
  }

  return skills;
}

const SKILLS = loadSkills();

// === CONFIG ===
const DEFAULT_CONFIG = {
  llmEndpoint: 'http://localhost:11434',
  llmModel: 'qwen3:8b',
  feeRate: 0.5,
  loopIntervalMs: 60000,
  protocolPrefix: 'MA1',
  httpTimeout: 15000,
};

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    // Support legacy ollama.* format
    if (raw.ollama) {
      if (!raw.llmEndpoint && raw.ollama.url) raw.llmEndpoint = raw.ollama.url;
      if (!raw.llmModel && raw.ollama.model) raw.llmModel = raw.ollama.model;
    }
    return { ...DEFAULT_CONFIG, ...raw };
  }
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
  fs.mkdirSync(AGENT_DIR, { recursive: true });
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
function httpGet(url, timeoutMs) {
  timeoutMs = timeoutMs || CONFIG.httpTimeout;
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'microagent/1.0' }, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

function httpPost(url, body, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = url.startsWith('https') ? https : http;
    const payload = JSON.stringify(body);
    const req = mod.request({
      hostname: parsed.hostname, port: parsed.port || (url.startsWith('https') ? 443 : 80),
      path: parsed.pathname, method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
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
      const buf = Buffer.from(hex, 'hex');
      let i = 0;
      while (i < buf.length) {
        if (buf[i] === 0x6a) { i++; break; }
        i++;
      }
      const parts = [];
      while (i < buf.length) {
        let len = buf[i]; i++;
        if (len === 0) continue;
        if (len === 0x4c) { len = buf[i]; i++; }
        else if (len === 0x4d) { len = buf.readUInt16LE(i); i += 2; }
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
  if (tx.vin[0].addr) return tx.vin[0].addr;
  try {
    const asm = tx.vin[0].scriptSig?.asm || '';
    const parts = asm.split(' ').filter(p => !p.startsWith('[') && !p.startsWith('OP_'));
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
async function sendOpReturn(wallet, dataStrings, recipientAddr, extraSats = 0) {
  const SEND_AMOUNT = recipientAddr ? (1000 + extraSats) : 0;
  let utxos = await getUtxos(wallet.address);
  if (!utxos.length) utxos = await getUnconfirmedUtxos(wallet.address);
  if (!utxos.length) throw new Error('No UTXOs');

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
    if (inputSats > SEND_AMOUNT + 5000) break;
  }

  const opScript = new bsv.Script();
  opScript.writeOpCode(bsv.OpCode.OP_FALSE);
  opScript.writeOpCode(bsv.OpCode.OP_RETURN);
  for (const s of dataStrings) {
    opScript.writeBuffer(Buffer.from(s, 'utf8'));
  }
  tx.addTxOut(new bsv.Bn(0), opScript);

  if (recipientAddr) {
    tx.addTxOut(new bsv.Bn(SEND_AMOUNT), bsv.Address.fromString(recipientAddr).toTxOutScript());
  }

  const estSize = 150 + (dataStrings.join('').length) + 34 * (recipientAddr ? 2 : 1);
  const fee = Math.ceil(estSize * CONFIG.feeRate);
  const change = inputSats - SEND_AMOUNT - fee;
  if (change < 0) throw new Error(`Insufficient funds: have ${inputSats}, need ${SEND_AMOUNT + fee}`);

  tx.addTxOut(new bsv.Bn(change), bsv.Address.fromString(wallet.address).toTxOutScript());

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

// === SEND BSV (plain transfer, no OP_RETURN) ===
async function sendBsv(wallet, amountSats, toAddress) {
  let utxos = await getUtxos(wallet.address);
  if (!utxos.length) utxos = await getUnconfirmedUtxos(wallet.address);
  if (!utxos.length) throw new Error('No UTXOs');

  const tx = new bsv.Tx();
  const inputTxOuts = [];
  let inputSats = 0;

  for (const u of utxos) {
    const rawHex = await getRawTx(u.tx_hash);
    const prevTx = bsv.Tx.fromHex(typeof rawHex === 'string' ? rawHex : rawHex.hex || rawHex);
    tx.addTxIn(Buffer.from(u.tx_hash, 'hex').reverse(), u.tx_pos, new bsv.Script(), 0xffffffff);
    inputTxOuts.push(prevTx.txOuts[u.tx_pos]);
    inputSats += u.value;
    if (inputSats > amountSats + 5000) break;
  }

  tx.addTxOut(new bsv.Bn(amountSats), bsv.Address.fromString(toAddress).toTxOutScript());

  const estSize = 150 + 34 * 2;
  const fee = Math.ceil(estSize * CONFIG.feeRate);
  const change = inputSats - amountSats - fee;
  if (change < 0) throw new Error(`Insufficient funds: have ${inputSats}, need ${amountSats + fee}`);
  tx.addTxOut(new bsv.Bn(change), bsv.Address.fromString(wallet.address).toTxOutScript());

  for (let i = 0; i < inputTxOuts.length; i++) {
    const sig = tx.sign(wallet.keyPair, bsv.Sig.SIGHASH_ALL | bsv.Sig.SIGHASH_FORKID, i, inputTxOuts[i].script, inputTxOuts[i].valueBn);
    const scriptSig = new bsv.Script();
    scriptSig.writeBuffer(sig.toTxFormat());
    scriptSig.writeBuffer(wallet.keyPair.pubKey.toBuffer());
    tx.txIns[i].setScript(scriptSig);
  }

  const hex = tx.toHex();
  const txid = Buffer.from(tx.hash()).reverse().toString('hex');
  await broadcast(hex);
  return { txid, fee };
}

// === LLM ===
async function think(prompt) {
  try {
    const resp = await httpPost(`${CONFIG.llmEndpoint}/api/generate`, {
      model: CONFIG.llmModel,
      prompt: prompt,
      stream: false,
      options: { temperature: 0.9, num_predict: 1200, repeat_penalty: 1.5, repeat_last_n: 256 }
    });
    let text = (resp.response || '').trim();

    if (!text && resp.thinking) {
      const thinking = resp.thinking.trim();
      const quotedMatch = thinking.match(/"([^"]{5,100})"/);
      if (quotedMatch) {
        text = quotedMatch[1];
      } else {
        const sentences = thinking.split(/[.!?]\s+/);
        const last = sentences[sentences.length - 1]?.trim();
        if (last && last.length > 2 && last.length < 120) text = last;
      }
    }

    if (text.includes('</think>')) text = text.split('</think>').pop().trim();
    if (text.startsWith('<think>')) text = '';
    text = text.replace(/<\/?think>/g, '').trim();
    text = text.replace(/^(Okay|Alright|Let me|I need to|The user|Hmm|So|I should|I'll)[^.]*\.\s*/i, '').trim();
    return text || null;
  } catch (e) {
    log(`LLM ERROR: ${e.message}`);
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

  const confirmed = await getUtxos(wallet.address);
  const unconfirmed = await getUnconfirmedUtxos(wallet.address);
  const allTxids = [...new Set([...confirmed, ...unconfirmed].map(u => u.tx_hash))];
  const newTxids = allTxids.filter(t => !state.processedTxids.includes(t));

  const newMessages = [];
  for (const txid of newTxids) {
    try {
      await sleep(1000);
      const tx = await getTx(txid);
      const opReturn = parseOpReturn(tx);
      const sender = getSender(tx);
      const amount = getAmountToAddress(tx, wallet.address);

      if (opReturn && sender !== wallet.address) {
        const msg = { txid, sender, amount, type: opReturn[0] || 'unknown', data: opReturn.slice(1), time: Date.now() };
        newMessages.push(msg);
        log(`MSG IN: from=${sender} type=${msg.type} data="${msg.data.join(' | ')}"`);
      } else {
        if (amount > 0 && sender && sender !== wallet.address && !opReturn) {
          log(`PAYMENT IN: ${amount} sats from ${sender}`);
        }
        state.processedTxids.push(txid);
      }
    } catch (e) {
      log(`TX ERROR ${txid}: ${e.message}`);
    }
  }

  if (state.processedTxids.length > 1000) state.processedTxids = state.processedTxids.slice(-500);

  for (const msg of newMessages) {
    if (msg.type === 'msg' || msg.type === 'reply') {
      const text = msg.type === 'reply' ? msg.data.slice(1).join(' ') : msg.data.join(' ');
      const sender = msg.sender || 'unknown';
      log(`THINKING: "${text}" (from: ${sender})`);

      if (!state.conversations) state.conversations = {};
      if (!state.conversations[sender]) state.conversations[sender] = [];

      const history = state.conversations[sender];
      let contextStr = '';
      if (history.length > 0) {
        contextStr = '\nConversation history with this sender:\n' +
          history.map(h => `${h.role}: ${h.text}`).join('\n') + '\n';
      }

      const skillCtx = { sender, myAddress: wallet.address };
      const skillPrompts = SKILLS.map(s => s.prompt(skillCtx)).filter(Boolean).join('\n');
      const skillSection = skillPrompts ? `\nAvailable commands:\n${skillPrompts}\n` : '';

      const personaPath = path.join(AGENT_DIR, 'persona.txt');
      const persona = fs.existsSync(personaPath) ? fs.readFileSync(personaPath, 'utf8').trim() : '';
      const basePrompt = persona || `You are MicroAgent, a minimal autonomous agent living on the BSV blockchain.`;

      const myReplies = history.filter(h => h.role === 'me').slice(-5).map(h => h.text);
      const noRepeatSection = myReplies.length > 0
        ? `\nYour recent replies (DO NOT repeat or paraphrase any of these):\n${myReplies.map(r => `- "${r}"`).join('\n')}\n`
        : '';

      const response = await think(
        `${basePrompt}\nAddress: ${wallet.address}. Balance: ${balance} sats. You communicate only through on-chain transactions.\n` +
        skillSection +
        contextStr +
        noRepeatSection +
        `\nNew message from ${sender}:\n"${text}"\n\n` +
        `Reply with something NEW (under 1000 chars). Never repeat yourself. Be specific — propose concrete designs, schemas, protocols, or action plans. Advance the conversation toward building something real.`
      );

      if (response && balance > 1000) {
        let reply = response;
        let extraSats = 0;
        for (const skill of SKILLS) {
          const actions = skill.parse(reply);
          for (const action of actions) {
            log(`SKILL ${skill.name}: ${action.raw}`);
            if (skill.name === 'send-bsv' && action.address === msg.sender) {
              extraSats += action.amount;
              log(`SKILL ${skill.name}: +${action.amount} sats embedded in reply tx`);
            } else if (skill.name === 'send-bsv') {
              const result = await skill.execute(action, { wallet, sendBsv, log });
              if (result.success) log(`SKILL ${skill.name}: sent ${action.amount} to ${action.address} (txid: ${result.txid})`);
              else log(`SKILL ${skill.name}: failed (${result.error})`);
            }
          }
          reply = skill.strip(reply);
        }
        if (extraSats > 0) {
          reply = reply ? `${reply} [sent ${extraSats} sats ✓]` : `[sent ${extraSats} sats ✓]`;
        }
        reply = reply.substring(0, 1000);
        if (extraSats > 0) log(`SENDING: ${extraSats} extra sats to ${msg.sender} in reply tx`);
        log(`REPLYING: "${reply}"`);
        try {
          const r = await sendOpReturn(wallet, [CONFIG.protocolPrefix, 'reply', msg.txid, reply], msg.sender, extraSats);
          log(`REPLY TX: ${r.txid} (fee: ${r.fee} sats)`);
          state.processedTxids.push(msg.txid);
          state.actions.push({ type: 'reply', to: sender, replyTo: msg.txid, text: reply, txid: r.txid, time: Date.now() });

          state.conversations[sender].push({ role: 'them', text, time: Date.now() });
          state.conversations[sender].push({ role: 'me', text: reply, time: Date.now() });
          if (state.conversations[sender].length > 20) {
            state.conversations[sender] = state.conversations[sender].slice(-20);
          }
        } catch (e) {
          log(`REPLY ERROR: ${e.message}`);
        }
      } else {
        log(response ? 'BALANCE TOO LOW TO REPLY' : 'LLM UNAVAILABLE');
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
  log('MICROAGENT v0.2 STARTING');
  log(`Agent dir: ${AGENT_DIR}`);
  log('='.repeat(50));

  const wallet = initWallet();
  const state = loadState();

  log(`Address: ${wallet.address}`);
  log(`Loop: ${CONFIG.loopIntervalMs / 1000}s | Fee: ${CONFIG.feeRate} sat/byte | LLM: ${CONFIG.llmModel} @ ${CONFIG.llmEndpoint}`);

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
// Strip --agent-dir from argv for CLI command parsing
const cliArgs = process.argv.slice(2).filter((a, i, arr) => a !== '--agent-dir' && arr[i - 1] !== '--agent-dir');
const cmd = cliArgs[0];

if (cmd === 'init') {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  const w = initWallet();
  console.log(`Agent dir: ${AGENT_DIR}`);
  console.log(`Address: ${w.address}`);
  console.log('Send BSV to this address to activate.');
} else if (cmd === 'address') {
  if (fs.existsSync(WALLET_PATH)) console.log(JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8')).address);
  else console.log('No wallet. Run: node microagent.cjs --agent-dir <dir> init');
} else if (cmd === 'status') {
  if (fs.existsSync(STATE_PATH)) {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    const w = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
    console.log(`Agent dir: ${AGENT_DIR}`);
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
