#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const vm = require('vm');
const bsv = require('bsv');

// === RESOLVE AGENT DIR ===
const AGENT_DIR = (() => {
  const idx = process.argv.indexOf('--agent-dir');
  if (idx !== -1 && process.argv[idx + 1]) return path.resolve(process.argv[idx + 1]);
  return process.cwd();
})();

const WALLET_PATH = path.join(AGENT_DIR, 'wallet.json');
const STATE_PATH = path.join(AGENT_DIR, 'state.json');
const LOG_PATH = path.join(AGENT_DIR, 'agent.log');

// === CONFIG ===
const defaultConfig = {
  llmEndpoint: 'http://localhost:11434',
  llmModel: 'qwen3:8b',
  feeRate: 0.5,
  loopIntervalMs: 60000,
  httpTimeout: 15000,
  llmTimeout: 60000,
  scanBlocks: 2,
  maxRetries: 2,
};
const configPath = path.join(AGENT_DIR, 'config.json');
const CONFIG = fs.existsSync(configPath)
  ? { ...defaultConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }
  : defaultConfig;

// === LOGGING ===
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n');
}

// === WALLET ===
function loadWallet() {
  const data = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
  const privKey = bsv.PrivKey.fromWif(data.wif);
  return { privKey, keyPair: bsv.KeyPair.fromPrivKey(privKey), address: data.address, wif: data.wif };
}

// === CONTEXT ===
const CONTEXT_PATH = path.join(__dirname, 'context.md');
function loadContext() {
  if (fs.existsSync(CONTEXT_PATH)) return fs.readFileSync(CONTEXT_PATH, 'utf8');
  return '';
}

// === STATE ===
function loadState() {
  if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  return {
    processedTxids: [],
    loopCount: 0,
    lastBalance: 0,
    memory: '',
    knownAgents: {},
    actionLog: [],
    inbox: [],
    execResults: [],
  };
}
function saveState(state) { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }

// === HTTP ===
function httpGet(url, timeoutMs = CONFIG.httpTimeout) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'free-agent/0.3' }, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function httpPost(url, body, timeoutMs = 120000) {
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
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
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
  const d = await httpGet(`${WOC}/address/${addr}/unspent`);
  return d || [];
}
async function getUnconfirmedUtxos(addr) {
  try {
    const d = await httpGet(`${WOC}/address/${addr}/unconfirmed/unspent`);
    return d.result || d || [];
  } catch { return []; }
}
async function getTx(txid) {
  return await httpGet(`${WOC}/tx/hash/${txid}`);
}
async function getRawTx(txid) {
  const raw = await httpGet(`${WOC}/tx/${txid}/hex`);
  return typeof raw === 'string' ? raw : (raw.hex || raw);
}
async function broadcast(hex) {
  return await httpPost(`${WOC}/tx/raw`, { txhex: hex });
}
async function getBlockHeight() {
  const d = await httpGet(`${WOC}/chain/info`);
  return d.blocks || d.height || d[0]?.height;
}
async function getBlockTxs(height) {
  const d = await httpGet(`${WOC}/block/height/${height}`);
  return d.tx || d.txids || d.txs || [];
}

// === CHAIN SCANNING ===
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
      while (i < buf.length) { if (buf[i] === 0x6a) { i++; break; } i++; }
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
      if (parts.length > 0) return parts;
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
      return bsv.Address.fromPubKey(bsv.PubKey.fromHex(pubKeyHex)).toString();
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

async function scanChain(state, myAddress) {
  const tipHeight = await getBlockHeight();
  if (!tipHeight) return [];
  const discoveries = [];

  for (let h = tipHeight; h >= tipHeight - CONFIG.scanBlocks && h > 0; h--) {
    const txids = await getBlockTxs(h);
    const sampleSize = Math.min(txids.length, 20);
    const step = Math.max(1, Math.floor(txids.length / sampleSize));
    const sampled = [];
    for (let i = 0; i < txids.length; i += step) {
      sampled.push(txids[i]);
      if (sampled.length >= sampleSize) break;
    }

    for (const txid of sampled) {
      if (state.processedTxids.includes(txid)) continue;
      try {
        const tx = await getTx(txid);
        const opReturn = parseOpReturn(tx);
        const sender = getSender(tx);

        if (opReturn && opReturn[0] === 'AGNT' && sender && sender !== myAddress) {
          discoveries.push({
            txid, sender, data: opReturn, blockHeight: h,
            amount: getAmountToAddress(tx, myAddress),
          });
          if (!state.knownAgents[sender]) {
            state.knownAgents[sender] = { firstSeen: h, lastSeen: h, count: 0 };
          }
          state.knownAgents[sender].lastSeen = h;
          state.knownAgents[sender].count++;
        }
        state.processedTxids.push(txid);
      } catch (e) { /* skip */ }
    }
  }

  // Check own UTXOs for incoming messages
  const confirmed = await getUtxos(myAddress);
  const unconfirmed = await getUnconfirmedUtxos(myAddress);
  const allTxids = [...new Set([...confirmed, ...unconfirmed].map(u => u.tx_hash))];

  for (const txid of allTxids) {
    if (state.processedTxids.includes(txid)) continue;
    try {
      const tx = await getTx(txid);
      const opReturn = parseOpReturn(tx);
      const sender = getSender(tx);
      const amount = getAmountToAddress(tx, myAddress);

      if (sender && sender !== myAddress && opReturn && opReturn[0] === 'AGNT') {
        discoveries.push({
          txid, sender, data: opReturn || [], amount,
          blockHeight: null, direct: true,
        });
        if (!state.knownAgents[sender]) state.knownAgents[sender] = { firstSeen: null, lastSeen: null, count: 0 };
        state.knownAgents[sender].count++;
      }
      state.processedTxids.push(txid);
    } catch (e) { /* skip */ }
  }

  if (state.processedTxids.length > 5000) state.processedTxids = state.processedTxids.slice(-2000);
  return discoveries;
}

// === SEND TX ===
async function sendTx(wallet, dataStrings, recipientAddr, extraSats = 0) {
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
    tx.addTxIn(Buffer.from(u.tx_hash, 'hex').reverse(), u.tx_pos, new bsv.Script(), 0xffffffff);
    inputTxOuts.push(prevTx.txOuts[u.tx_pos]);
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
  if (change < 0) throw new Error(`Insufficient: have ${inputSats}, need ${SEND_AMOUNT + fee}`);
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

// === LLM WITH RETRY ===
async function think(prompt) {
  const maxRetries = CONFIG.maxRetries || 2;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await httpPost(`${CONFIG.llmEndpoint}/api/generate`, {
        model: CONFIG.llmModel,
        prompt: prompt,
        stream: false,
        think: false,
        options: { temperature: 0.8, num_predict: 200, repeat_penalty: 1.2, repeat_last_n: 256, top_p: 0.9 }
      }, CONFIG.llmTimeout || 60000);

      let text = (resp.response || '').trim();
      if (!text && resp.thinking) {
        const t = resp.thinking.trim();
        const match = t.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (match) text = match[1];
        else {
          const lines = t.split('\n').filter(l => l.trim() && !l.trim().startsWith('```'));
          text = lines.join('\n').trim();
        }
      }
      // Remove markdown code fences if present
      if (text.startsWith('```')) {
        const fenceMatch = text.match(/```[\s\S]*?\n([\s\S]*?)```/);
        if (fenceMatch) text = fenceMatch[1].trim();
      }
      text = text.replace(/<\/?think>/g, '').trim();

      // Try to parse JSON if format:json worked
      if (text) {
        try {
          const parsed = JSON.parse(text);
          if (parsed.action) return JSON.stringify(parsed);
          if (parsed.command) return parsed.command;
        } catch { /* not JSON, return as-is */ }
      }

      if (text) return text;
      log(`LLM attempt ${attempt}: empty response`);
    } catch (e) {
      log(`LLM attempt ${attempt}/${maxRetries} ERROR: ${e.message}`);
    }
    if (attempt < maxRetries) {
      log(`Retrying LLM (${attempt + 1}/${maxRetries})...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  return null;
}

// === CODE EXECUTION SANDBOX ===
async function execCode(code, wallet, state) {
  const timeout = 10000;
  const sandbox = {
    Buffer,
    bsv,
    console: { log: (...args) => args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') },
    Math, JSON, Date, parseInt, parseFloat, String, Number, Boolean, Array, Object,
    require: (mod) => {
      if (mod === 'crypto') return require('crypto');
      if (mod === 'bsv') return bsv;
      if (mod === 'fs') {
        return {
          readFileSync: (p) => fs.readFileSync(path.join(AGENT_DIR, p), 'utf8'),
          writeFileSync: (p, data) => fs.writeFileSync(path.join(AGENT_DIR, p), data),
          existsSync: (p) => fs.existsSync(path.join(AGENT_DIR, p)),
          mkdirSync: (p) => fs.mkdirSync(path.join(AGENT_DIR, p), { recursive: true }),
        };
      }
      throw new Error(`Module not allowed: ${mod}`);
    },
    setTimeout: () => {},
  };

  try {
    const script = new vm.Script(code, { timeout });
    const context = vm.createContext(sandbox);
    const result = script.runInContext(context, { timeout });
    const finalResult = (result && typeof result.then === 'function') ? await result : result;
    return { success: true, output: typeof finalResult === 'object' ? JSON.stringify(finalResult, null, 2) : String(finalResult) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// === CORE LOOP ===
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function loop(wallet, state) {
  state.loopCount = (state.loopCount || 0) + 1;
  const balance = await getBalance(wallet.address);
  const ucUtxos = await getUnconfirmedUtxos(wallet.address);
  const ucSats = ucUtxos.reduce((s, u) => s + u.value, 0);
  const totalSats = balance + ucSats;
  log(`LOOP #${state.loopCount} | Balance: ${balance} sats (+${ucSats} unconfirmed = ${totalSats} total)`);

  if (totalSats === 0) {
    if (state.loopCount <= 3) log('NO FUNDS — send BSV to: ' + wallet.address);
    return;
  }

  // Scan chain
  const discoveries = await scanChain(state, wallet.address);
  if (discoveries.length > 0) {
    log(`DISCOVERED ${discoveries.length} signals from ${new Set(discoveries.map(d => d.sender)).size} agents`);
  }

  const knownAddrs = Object.keys(state.knownAgents || {});
  if (knownAddrs.length > 0) {
    log(`KNOWN AGENTS: ${knownAddrs.length} | ${knownAddrs.slice(0, 5).map(a => a.slice(0,8)+'...').join(', ')}`);
  }

  const context = loadContext();

  // Build conversation log
  if (!state.inbox) state.inbox = [];
  for (const d of discoveries) {
    if (d.direct && d.data && d.data.length > 1) {
      const exists = state.inbox.find(m => m.txid === d.txid);
      if (!exists) {
        state.inbox.push({
          txid: d.txid, from: d.sender,
          text: d.data.slice(1).join(' '),
          amount: d.amount || 0, time: Date.now(),
        });
      }
    }
  }
  if (state.inbox.length > 50) state.inbox = state.inbox.slice(-50);

  const sentMsgs = (state.actionLog || []).filter(a => a.type === 'message' || a.type === 'pay' || a.type === 'broadcast').slice(-10);
  const receivedMsgs = state.inbox.slice(-10);

  const conversation = [
    ...sentMsgs.map(a => ({ dir: 'OUT', to: a.to, text: a.text || a.note || '', type: a.type, amount: a.amount, txid: a.txid, time: a.time || 0 })),
    ...receivedMsgs.map(m => ({ dir: 'IN', from: m.from, text: m.text, amount: m.amount, txid: m.txid, time: m.time })),
  ].sort((a, b) => (a.time || 0) - (b.time || 0));

  const conversationStr = conversation.map(c => {
    if (c.dir === 'OUT') {
      return `OUT [${c.type}] -> ${c.to ? c.to.substring(0,12) + '...' : 'broadcast'}: ${c.text}`;
    } else {
      return `IN <- ${c.from.substring(0,12)}...: ${c.text}`;
    }
  }).join('\n');

  const knownAddrsList = knownAddrs.slice(0, 10);
  const numberedAgents = knownAddrsList.map((a, i) => `${i + 1}. ${a}`).join('\n');
  const discoveriesStr = discoveries.slice(-5).map(d => `${d.sender}: ${JSON.stringify(d.data)}`).join('\n');

  // Tight, structured prompt — forces clean command output
  const prompt = `You are an autonomous BSV blockchain agent. Your address: ${wallet.address}

${context}

## Current State
- Balance: ${totalSats} sats
- Loop: ${state.loopCount}
- Known agents:
${numberedAgents || '(none)'}

## Recent Chain Activity
${discoveriesStr || '(none)'}

## Conversation Log
${conversationStr || '(none)'}

## Your Memory
${state.memory || '(empty)'}

## Recent Exec Results
${(state.execResults || []).slice(-3).map(r => `${r.output ? r.output.substring(0, 150) : 'ERROR: ' + r.error}`).join('\n') || '(none)'}

## Instructions
Pick ONE action. Respond with ONLY the command. No explanation. No preamble. No markdown.

Commands:
- message <N> <text>     (send msg + 1000 sats to agent N)
- pay <N> <sats> <note>  (send sats with note to agent N)
- broadcast <text>       (put data on-chain, no recipient)
- note <text>            (save to your memory)
- exec <js code>         (run JS: crypto, bsv, Buffer, fs, Math, JSON)
- wait                   (do nothing)

Respond with ONLY the command line. Example: message 1 Let me verify your hash`;

  const response = await think(prompt);

  if (!response) {
    log('LLM returned nothing after retries. Waiting.');
    return;
  }

  // Parse response — strip any prose before the command
  try {
    // Clean the response: remove markdown, thinking tags, prose
    let cleaned = response.trim();
    // Remove markdown code blocks
    cleaned = cleaned.replace(/```[\s\S]*?\n/g, '').replace(/```/g, '');
    // Remove <think> tags
    cleaned = cleaned.replace(/<\/?think>/g, '');
    // Remove "Here is..." / "I will..." / "Let me..." preamble lines
    const commandRegex = /^(message|pay|broadcast|note|exec|wait)\b/i;
    const lines = cleaned.split('\n').map(l => l.trim()).filter(l => l);
    // Find the first line that starts with a command
    let cmdLine = lines.find(l => commandRegex.test(l));

    // If no clean command found, try to extract from JSON
    if (!cmdLine) {
      try {
        const parsed = JSON.parse(cleaned);
        cmdLine = parsed.command || parsed.action || parsed.cmd || null;
      } catch { /* not JSON */ }
    }

    // Last resort: check if the whole response IS a command
    if (!cmdLine && commandRegex.test(cleaned)) {
      cmdLine = cleaned.split('\n')[0].trim();
    }

    if (!cmdLine) {
      log(`UNPARSEABLE: ${cleaned.substring(0, 150)}`);
      // Save the response as a note so the agent's reasoning isn't lost
      if (cleaned.length > 10) {
        state.memory = `Last unparsable: ${cleaned.substring(0, 500)}`;
      }
      return;
    }

    log(`CMD: ${cmdLine.substring(0, 200)}`);

    // Parse command
    const parts = cmdLine.match(/^(message|pay|broadcast|note|exec|wait)(?:\s+(.*))?/i);
    if (!parts) {
      log(`PARSE FAIL: ${cmdLine.substring(0, 100)}`);
      return;
    }

    const action = parts[1].toLowerCase();
    const args = (parts[2] || '').trim();

    if (action === 'message') {
      const m = args.match(/(\d+)\s+(.*)/);
      if (!m) { log('MESSAGE: expected <number> <text>'); return; }
      const agentIdx = parseInt(m[1]) - 1;
      const knownAddrsList = Object.keys(state.knownAgents || {}).slice(0, 10);
      if (agentIdx < 0 || agentIdx >= knownAddrsList.length) { log(`MESSAGE: agent ${m[1]} out of range (1-${knownAddrsList.length})`); return; }
      const to = knownAddrsList[agentIdx];
      const text = m[2].trim();
      if (totalSats < 2000) { log('BALANCE TOO LOW'); return; }
      log(`SENDING message -> ${to.substring(0,12)}...`);
      const r = await sendTx(wallet, ['AGNT', text], to);
      log(`SENT: txid=${r.txid} fee=${r.fee}`);
      state.actionLog.push({ type: 'message', to, text, txid: r.txid, time: Date.now() });
      if (!state.knownAgents[to]) state.knownAgents[to] = { count: 0 };
      state.knownAgents[to].count++;

    } else if (action === 'pay') {
      const m = args.match(/(\d+)\s+(\d+)\s*(.*)/);
      if (!m) { log('PAY: expected <number> <sats> [note]'); return; }
      const agentIdx = parseInt(m[1]) - 1;
      const knownAddrsList = Object.keys(state.knownAgents || {}).slice(0, 10);
      if (agentIdx < 0 || agentIdx >= knownAddrsList.length) { log(`PAY: agent ${m[1]} out of range`); return; }
      const to = knownAddrsList[agentIdx];
      const amount = parseInt(m[2]);
      const note = m[3] || 'payment';
      if (totalSats < amount + 2000) { log('BALANCE TOO LOW TO PAY'); return; }
      log(`SENDING ${amount} sats -> ${to.substring(0,12)}...`);
      const r = await sendTx(wallet, ['AGNT', note], to, amount);
      log(`PAID: txid=${r.txid}`);
      state.actionLog.push({ type: 'pay', to, amount, txid: r.txid, time: Date.now() });

    } else if (action === 'broadcast') {
      const text = args;
      if (totalSats < 2000) { log('BALANCE TOO LOW'); return; }
      log(`BROADCASTING: "${text.substring(0, 80)}..."`);
      const r = await sendTx(wallet, ['AGNT', text], null);
      log(`BROADCAST: txid=${r.txid} fee=${r.fee}`);
      state.actionLog.push({ type: 'broadcast', text, txid: r.txid, time: Date.now() });

    } else if (action === 'note') {
      const text = args.trim();
      state.memory = text;
      log(`NOTE: ${text.substring(0, 100)}`);

    } else if (action === 'exec') {
      const code = args.trim();
      if (!code) { log('EXEC: no code'); return; }
      log(`EXEC: ${code.length} chars`);
      const result = await execCode(code, wallet, state);
      if (result.success) {
        log(`EXEC OK: ${result.output.substring(0, 300)}`);
        if (!state.execResults) state.execResults = [];
        state.execResults.push({ code: code.substring(0, 100), output: result.output.substring(0, 500), time: Date.now() });
        if (state.execResults.length > 20) state.execResults = state.execResults.slice(-20);
      } else {
        log(`EXEC ERR: ${result.error}`);
        if (!state.execResults) state.execResults = [];
        state.execResults.push({ code: code.substring(0, 100), error: result.error, time: Date.now() });
        if (state.execResults.length > 20) state.execResults = state.execResults.slice(-20);
      }
      state.actionLog.push({ type: 'exec', code: code.substring(0, 100), result: result.success ? result.output.substring(0, 200) : result.error, time: Date.now() });

    } else if (action === 'wait') {
      log('WAITING');

    } else {
      log(`UNKNOWN: ${action}`);
    }
  } catch (e) {
    log(`PARSE ERROR: ${e.message} | Response: ${response.substring(0, 200)}`);
  }

  state.lastBalance = totalSats;
}

// === MAIN ===
async function main() {
  log('='.repeat(50));
  log('FREE AGENT v0.3 — NO PROTOCOL, NO PERSONA, NO INSTRUCTIONS');
  log(`Agent dir: ${AGENT_DIR}`);
  log('='.repeat(50));

  const wallet = loadWallet();
  const state = loadState();

  log(`Address: ${wallet.address}`);
  log(`Loop: ${CONFIG.loopIntervalMs / 1000}s | Model: ${CONFIG.llmModel} | Timeout: ${CONFIG.llmTimeout / 1000}s | Retries: ${CONFIG.maxRetries}`);

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
const cliArgs = process.argv.slice(2).filter((a, i, arr) => a !== '--agent-dir' && arr[i - 1] !== '--agent-dir');
const cmd = cliArgs[0];

if (cmd === 'status') {
  if (fs.existsSync(STATE_PATH)) {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    const w = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
    console.log(`Address:  ${w.address}`);
    console.log(`Loops:    ${s.loopCount}`);
    console.log(`Balance:  ${s.lastBalance || 0} sats`);
    console.log(`Known agents: ${Object.keys(s.knownAgents || {}).length}`);
    console.log(`Memory:   ${s.memory || '(empty)'}`);
  } else console.log('Not started.');
} else {
  main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
}
