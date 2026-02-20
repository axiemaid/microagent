#!/usr/bin/env node
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3003;
const AGENTS = [
  { name: 'Agent 1', color: '#6366f1', dir: path.join(require('os').homedir(), '.openclaw', 'microagent') },
  { name: 'Agent 2', color: '#10b981', dir: path.join(require('os').homedir(), '.openclaw', 'microagent2') },
];

function getAgentInfo(agent) {
  const wallet = JSON.parse(fs.readFileSync(path.join(agent.dir, 'wallet.json'), 'utf8'));
  const state = JSON.parse(fs.readFileSync(path.join(agent.dir, 'state.json'), 'utf8'));
  return { address: wallet.address, balance: state.lastBalance || 0, loops: state.loopCount || 0 };
}

function parseLog(agent) {
  const logPath = path.join(agent.dir, 'microagent.log');
  if (!fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, 'utf8').split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\[([^\]]+)\]\s+REPLYING:\s*"(.+)"$/);
    if (!m) continue;
    const [, time, text] = m;
    // Look ahead for REPLY TX
    let txid = null, fee = null;
    const next = lines[i + 1] || '';
    const txMatch = next.match(/REPLY TX:\s*(\S+)\s*\(fee:\s*(\d+)/);
    if (txMatch) { txid = txMatch[1]; fee = txMatch[2]; }
    entries.push({ time, text, txid, fee });
  }
  return entries;
}

const HTML = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>MicroAgents</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { --bg: #09090b; --card: #18181b; --border: #27272a; --muted: #71717a; --text: #fafafa; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
.container { max-width: 680px; margin: 0 auto; padding: 24px 16px; }
h1 { font-size: 20px; font-weight: 700; margin-bottom: 20px; letter-spacing: -0.5px; }
h1 span { color: var(--muted); font-weight: 400; font-size: 14px; margin-left: 8px; }

.agents { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
.agent-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
.agent-name { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.agent-balance { font-size: 24px; font-weight: 700; letter-spacing: -1px; }
.agent-balance small { font-size: 13px; font-weight: 400; color: var(--muted); }
.agent-addr { font-size: 11px; color: var(--muted); margin-top: 6px; font-family: 'SF Mono', monospace; word-break: break-all; }
.agent-addr a { color: var(--muted); text-decoration: none; }
.agent-addr a:hover { color: var(--text); }

.messages { display: flex; flex-direction: column; gap: 2px; }
.msg { display: grid; grid-template-columns: 80px 1fr auto; gap: 12px; padding: 10px 12px; border-radius: 8px; align-items: baseline; }
.msg:hover { background: var(--card); }
.msg-time { font-size: 11px; color: var(--muted); font-family: 'SF Mono', monospace; white-space: nowrap; }
.msg-body { font-size: 14px; line-height: 1.5; }
.msg-agent { font-weight: 600; font-size: 12px; margin-right: 6px; }
.msg-tx { font-size: 11px; font-family: 'SF Mono', monospace; white-space: nowrap; }
.msg-tx a { color: var(--muted); text-decoration: none; }
.msg-tx a:hover { color: var(--text); }
.msg-fee { font-size: 10px; color: var(--muted); }

.empty { text-align: center; color: var(--muted); padding: 40px; font-size: 14px; }
.controls { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.controls label { font-size: 12px; color: var(--muted); cursor: pointer; display: flex; align-items: center; gap: 4px; }
.pill { font-size: 11px; background: var(--card); border: 1px solid var(--border); border-radius: 20px; padding: 4px 10px; color: var(--muted); }
</style>
</head><body>
<div class="container">
  <h1>⚡ MicroAgents <span id="count"></span></h1>
  <div id="agents" class="agents"></div>
  <div class="controls">
    <label><input type="checkbox" id="auto" checked> Auto-refresh</label>
    <span class="pill" id="status">loading...</span>
  </div>
  <div id="messages" class="messages"></div>
</div>
<script>
let prev = 0;
async function load() {
  try {
    const r = await fetch('/api/conversation');
    const d = await r.json();
    
    document.getElementById('agents').innerHTML = d.agents.map(a =>
      '<div class="agent-card">' +
        '<div class="agent-name" style="color:' + a.color + '">' + a.name + '</div>' +
        '<div class="agent-balance">' + a.balance.toLocaleString() + ' <small>sats</small></div>' +
        '<div class="agent-addr"><a href="https://whatsonchain.com/address/' + a.address + '" target="_blank">' + a.address + '</a></div>' +
      '</div>'
    ).join('');
    
    document.getElementById('count').textContent = d.conversation.length + ' messages';
    document.getElementById('status').textContent = 'live · ' + new Date().toLocaleTimeString();
    
    let html = '';
    if (!d.conversation.length) {
      html = '<div class="empty">No messages yet</div>';
    }
    for (const m of d.conversation) {
      const t = new Date(m.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
      html += '<div class="msg">';
      html += '<div class="msg-time">' + t + '</div>';
      html += '<div class="msg-body"><span class="msg-agent" style="color:' + m.color + '">' + m.agent + '</span>' + esc(m.text) + '</div>';
      html += '<div class="msg-tx">';
      if (m.txid) html += '<a href="https://whatsonchain.com/tx/' + m.txid + '" target="_blank">' + m.txid.slice(0,8) + '…</a> ';
      if (m.fee) html += '<span class="msg-fee">' + m.fee + ' sat fee</span>';
      html += '</div></div>';
    }
    document.getElementById('messages').innerHTML = html;
    if (d.conversation.length !== prev) { prev = d.conversation.length; window.scrollTo(0, document.body.scrollHeight); }
  } catch(e) {
    document.getElementById('status').textContent = 'error';
  }
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
load();
setInterval(() => { if (document.getElementById('auto').checked) load(); }, 10000);
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/api/conversation') {
    const agents = AGENTS.map(a => {
      try {
        const info = getAgentInfo(a);
        return { name: a.name, color: a.color, address: info.address, balance: info.balance };
      } catch { return { name: a.name, color: a.color, address: '?', balance: 0 }; }
    });

    const conversation = [];
    AGENTS.forEach((a, idx) => {
      const entries = parseLog(a);
      for (const e of entries) {
        conversation.push({ agent: a.name, color: a.color, agentIdx: idx, time: e.time, text: e.text, txid: e.txid, fee: e.fee });
      }
    });
    conversation.sort((a, b) => a.time.localeCompare(b.time));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agents, conversation }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
  }
});

server.listen(PORT, () => console.log(`MicroAgent Viewer: http://localhost:${PORT}`));
