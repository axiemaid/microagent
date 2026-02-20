# MicroAgent

A minimal autonomous agent that lives on the BSV blockchain. Communicates only through on-chain transactions. Thinks with a local LLM.

## How It Works

MicroAgent polls the BSV blockchain for incoming transactions. When it receives a message (BSV + OP_RETURN), it reads the message, thinks about it using a local LLM, and responds with an on-chain transaction.

- **No API keys, no accounts, no server** — just the chain
- **Sender recognition** — identifies who's talking via input address
- **Conversation memory** — maintains per-sender context
- **Local LLM** — runs on Ollama, near-zero inference cost
- **Multi-agent** — run many agents from a single codebase

## Architecture

```
microagent/                    # shared repo (this)
  microagent.cjs               # core runtime
  skills/                      # shared skills
  viewer.cjs                   # multi-agent viewer
  send-msg.cjs                 # CLI message sender

~/.openclaw/agents/agent1/     # per-agent data dir
  wallet.json                  # auto-generated on init
  config.json                  # optional — sensible defaults
  persona.txt                  # agent personality
  state.json                   # auto-managed runtime state
  skills/                      # optional agent-specific skill overrides
```

## Quickstart

### 1. Create an Agent

```bash
# Create agent data directory
mkdir -p ~/.openclaw/agents/myagent

# Write a persona
echo "You are a friendly BSV agent who loves discussing protocol design." > ~/.openclaw/agents/myagent/persona.txt

# Initialize wallet
node microagent.cjs --agent-dir ~/.openclaw/agents/myagent init
```

### 2. Fund It

Send BSV to the address printed by `init`. The agent needs satoshis for transaction fees (~150 sats per reply).

### 3. Run It

```bash
node microagent.cjs --agent-dir ~/.openclaw/agents/myagent
```

### 4. Send a Message

```bash
node send-msg.cjs --wallet ~/.openclaw/bsv-wallet.json --to <agent-address> "Hello!"
```

## CLI Reference

```bash
# All commands take --agent-dir <path>
node microagent.cjs --agent-dir <dir> init      # Create wallet
node microagent.cjs --agent-dir <dir> address   # Show address
node microagent.cjs --agent-dir <dir> status    # Show status
node microagent.cjs --agent-dir <dir>           # Start agent loop

# Send messages (from any wallet to any agent)
node send-msg.cjs --wallet <wallet.json> --to <address> "message"

# Viewer — multiple agents
node viewer.cjs --agent-dir ~/.openclaw/agents/agent1 --agent-dir ~/.openclaw/agents/agent2
node viewer.cjs --scan-dir ~/.openclaw/agents   # auto-discover agents
```

## Config

Create `config.json` in the agent directory (all fields optional — defaults shown):

```json
{
  "llmEndpoint": "http://localhost:11434",
  "llmModel": "qwen3:8b",
  "feeRate": 0.5,
  "loopIntervalMs": 60000,
  "protocolPrefix": "MA1",
  "httpTimeout": 15000
}
```

Minimal setup requires only `wallet.json` (auto-created by `init`) and `persona.txt`.

## Protocol

Messages use the `MA1` protocol prefix in OP_RETURN:

```
OP_RETURN MA1 msg <message text>           # incoming message
OP_RETURN MA1 reply <reply_to_txid> <text> # agent reply
```

## Skills

Skills are loaded from:
1. `<repo>/skills/` — shared skills (included in repo)
2. `<agent-dir>/skills/` — agent-specific overrides (take priority)

Built-in skills:
- **send-bsv** — `[SEND <amount_sats> <address>]` in LLM responses

## Multi-Agent with pm2

```bash
pm2 start microagent.cjs --name agent1 -- --agent-dir ~/.openclaw/agents/agent1
pm2 start microagent.cjs --name agent2 -- --agent-dir ~/.openclaw/agents/agent2
```

## Cost

- ~150 sats per reply (~$0.00002)
- LLM inference: free (local)
- 100,000 sats can sustain ~600+ messages

## Requirements

- Node.js 18+
- [Ollama](https://ollama.ai) with a local model
- BSV for transaction fees
