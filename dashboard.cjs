#!/usr/bin/env node
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PORT = process.env.PORT || 3026;
const AGENTS_DIR = path.join(process.env.HOME, '.openclaw', 'agents');
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';

// Only show agents with a free-agent state.json (skip old agent1/agent2/localboss/main)
const ACTIVE_AGENTS = ['free1', 'free2', 'free3'];

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'free-agent-viewer/0.2' }, timeout: 10000 }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

function loadAgent(name) {
  const dir = path.join(AGENTS_DIR, name);
  const walletPath = path.join(dir, 'wallet.json');
  if (!fs.existsSync(walletPath)) return null;
  const wallet = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  const statePath = path.join(dir, 'state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
  const logPath = path.join(dir, 'agent.log');
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim()) : [];

  // Parse log into structured events
  const events = log.map(line => {
    const m = line.match(/^\[([^\]]+)\] (.+)$/);
    if (!m) return { time: '', text: line };
    const time = m[1];
    const text = m[2];
    let type = 'info';
    if (text.includes('SENT') || text.includes('BROADCAST') || text.includes('PAID')) type = 'action';
    else if (text.includes('DECISION')) type = 'decision';
    else if (text.includes('ERROR') || text.includes('FAIL')) type = 'error';
    else if (text.includes('DISCOVERED') || text.includes('KNOWN')) type = 'discovery';
    else if (text.includes('LOOP #')) type = 'loop';
    else if (text.includes('RAW RESPONSE')) type = 'response';
    else if (text.includes('WAITING')) type = 'wait';
    else if (text.includes('MEMORY') || text.includes('NOTE')) type = 'note';
    return { time, text, type };
  });

  return {
    name,
    dir,
    address: wallet.address,
    balance: state.lastBalance || 0,
    loopCount: state.loopCount || 0,
    knownAgents: Object.keys(state.knownAgents || {}),
    knownCount: Object.keys(state.knownAgents || {}).length,
    actionLog: state.actionLog || [],
    memory: state.memory || '',
    events: events.slice(-50),
    logRaw: log.slice(-30),
  };
}

async function getBalance(addr) {
  try {
    const d = await httpGet(`${WOC}/address/${addr}/balance`);
    return (d.confirmed || 0) + (d.unconfirmed || 0);
  } catch { return null; }
}

async function getRecentTxs(addr) {
  try {
    const d = await httpGet(`${WOC}/address/${addr}/history`);
    return (d || []).slice(-5).map(t => ({ txid: t.tx_hash || t.txid, height: t.block_height }));
  } catch { return []; }
}

async function getOpReturn(txid) {
  try {
    const tx = await httpGet(`${WOC}/tx/hash/${txid}`);
    if (!tx.vout) return null;
    for (const out of tx.vout) {
      const asm = out.scriptPubKey?.asm || '';
      if (!asm.includes('OP_RETURN')) continue;
      const hex = out.scriptPubKey?.hex;
      if (!hex) continue;
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
      return { parts, outputs: tx.vout.filter(o => o.scriptPubKey?.addresses).map(o => ({ addr: o.scriptPubKey.addresses[0], value: o.value })) };
    }
  } catch { return null; }
  return null;
}

const HTML = (data) => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Free Agents — BSV</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #0a0a0a; color: #e0e0e0; font-family: -apple-system, 'SF Mono', 'Fira Code', monospace; padding: 16px; }
h1 { color: #fff; font-size: 1.3em; margin-bottom: 2px; }
.subtitle { color: #555; font-size: 0.8em; margin-bottom: 16px; }
.toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.toolbar button { background: #1a1a1a; color: #888; border: 1px solid #333; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 0.8em; }
.toolbar button:hover { background: #222; color: #fff; }
.auto-toggle { color: #555; font-size: 0.75em; }
.auto-toggle label { cursor: pointer; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 14px; }
.agent-card { background: #131313; border: 1px solid #2a2a2a; border-radius: 10px; overflow: hidden; }
.agent-header { background: #1a1a1a; padding: 12px 14px; border-bottom: 1px solid #2a2a2a; display: flex; justify-content: space-between; align-items: center; }
.agent-name { color: #10b981; font-weight: bold; font-size: 1em; }
.agent-status { font-size: 0.7em; padding: 2px 8px; border-radius: 10px; }
.status-active { background: #064e3b; color: #34d399; }
.status-idle { background: #444; color: #999; }
.agent-body { padding: 12px 14px; }
.agent-addr { font-size: 0.75em; color: #6366f1; margin-bottom: 8px; }
.agent-addr a { color: #6366f1; text-decoration: none; }
.agent-addr a:hover { text-decoration: underline; }
.stats { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.stat { background: #1a1a1a; padding: 4px 10px; border-radius: 6px; font-size: 0.75em; }
.stat-balance { color: #f59e0b; }
.stat-loops { color: #6366f1; }
.stat-known { color: #06b6d4; }
.stat-fee { color: #888; }
.memory-box { background: #0d0d0d; border-left: 3px solid #8b5cf6; padding: 8px 10px; margin: 8px 0; font-size: 0.75em; color: #aaa; border-radius: 0 6px 6px 0; }
.memory-label { color: #8b5cf6; font-weight: bold; font-size: 0.85em; }
.actions-box { margin: 8px 0; }
.actions-label { color: #666; font-size: 0.7em; text-transform: uppercase; margin-bottom: 4px; }
.action-item { background: #0d0d0d; padding: 6px 10px; margin: 3px 0; border-radius: 6px; font-size: 0.72em; border-left: 3px solid #333; }
.action-item.msg { border-left-color: #10b981; }
.action-item.pay { border-left-color: #f59e0b; }
.action-item.broadcast { border-left-color: #06b6d4; }
.action-item a { color: #6366f1; text-decoration: none; }
.action-item a:hover { text-decoration: underline; }
.log-box { margin-top: 8px; }
.log-label { color: #666; font-size: 0.7em; text-transform: uppercase; margin-bottom: 4px; cursor: pointer; }
.log-lines { max-height: 250px; overflow-y: auto; }
.log-lines::-webkit-scrollbar { width: 4px; }
.log-lines::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
.log-line { font-size: 0.68em; padding: 2px 0; color: #555; line-height: 1.4; }
.log-line .time { color: #333; }
.log-line.action { color: #34d399; }
.log-line.decision { color: #818cf8; }
.log-line.error { color: #ef4444; }
.log-line.discovery { color: #22d3ee; }
.log-line.loop { color: #fbbf24; }
.log-line.response { color: #a78bfa; }
.log-line.wait { color: #666; }
.log-line.note { color: #c084fc; }
.footer { margin-top: 24px; color: #222; font-size: 0.65em; text-align: center; }
</style>
</head>
<body>
<div class="toolbar">
  <div>
    <h1>🤖 Free Agents</h1>
    <div class="subtitle">Autonomous AI agents on BSV • No protocol • No persona • ${data.agents.length} agents • ${data.totalSats.toLocaleString()} sats total</div>
  </div>
  <div style="display:flex; gap:8px; align-items:center;">
    <span class="auto-toggle"><label><input type="checkbox" id="autoRefresh" onchange="toggleAuto()"> Auto (30s)</label></span>
    <button onclick="location.reload()">↻ Refresh</button>
  </div>
</div>

<div class="grid">
${data.agents.map(a => `
  <div class="agent-card">
    <div class="agent-header">
      <span class="agent-name">${a.name}</span>
      <span class="agent-status ${a.isRunning ? 'status-active' : 'status-idle'}">${a.isRunning ? 'ACTIVE' : 'IDLE'}</span>
    </div>
    <div class="agent-body">
      <div class="agent-addr">
        <a href="https://whatsonchain.com/address/${a.address}" target="_blank">${a.address}</a>
      </div>
      <div class="stats">
        <span class="stat stat-balance">💰 ${a.balance.toLocaleString()} sats</span>
        <span class="stat stat-loops">🔄 ${a.loopCount} loops</span>
        <span class="stat stat-known">👥 ${a.knownCount} known</span>
      </div>
      ${a.memory ? `<div class="memory-box"><span class="memory-label">📝 Self-notes:</span> ${a.memory.substring(0, 300)}</div>` : ''}
      <div class="actions-box">
        <div class="actions-label">Recent Actions</div>
        ${a.actionLog.length > 0 ? a.actionLog.slice(-5).reverse().map(act => `
          <div class="action-item ${act.type}">
            ${act.type === 'message' ? '💬' : act.type === 'pay' ? '💸' : '📢'} 
            ${act.type} ${act.to ? '→ <a href="https://whatsonchain.com/address/' + act.to + '" target="_blank">' + act.to.substring(0,12) + '...</a>' : ''}
            ${act.text ? '"' + act.text.substring(0,80) + '"' : ''}
            ${act.amount ? act.amount + ' sats' : ''}
            ${act.txid ? '<a href="https://whatsonchain.com/tx/' + act.txid + '" target="_blank">tx↗</a>' : ''}
          </div>
        `).join('') : '<div style="color:#444; font-size:0.75em; padding:4px;">No actions yet</div>'}
      </div>
      <div class="log-box">
        <div class="log-label" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'">▼ Activity Log</div>
        <div class="log-lines">
          ${a.events.map(e => `<div class="log-line ${e.type}"><span class="time">${e.time.substring(11,19)}</span> ${e.text.substring(0, 150)}</div>`).join('')}
        </div>
      </div>
    </div>
  </div>
`).join('')}
</div>

<div class="footer">
  Free Agent Dashboard v0.2 • ${new Date().toISOString()} • <a href="https://whatsonchain.com" target="_blank" style="color:#333;">WhatOnChain</a>
</div>

<script>
let autoTimer = null;
function toggleAuto() {
  const cb = document.getElementById('autoRefresh');
  if (cb.checked) {
    autoTimer = setInterval(() => location.reload(), 30000);
  } else {
    clearInterval(autoTimer);
  }
}
</script>
</body>
</html>`;

async function handleRequest(req, res) {
  const agents = [];
  for (const name of ACTIVE_AGENTS) {
    const a = loadAgent(name);
    if (!a) continue;
    const liveBal = await getBalance(a.address);
    if (liveBal !== null) a.balance = liveBal;
    a.isRunning = true; // could check process list but they're running
    agents.push(a);
  }

  const totalSats = agents.reduce((s, a) => s + a.balance, 0);
  const html = HTML({ agents, totalSats });
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`Free Agent Dashboard v0.2 on http://localhost:${PORT}`);
});
