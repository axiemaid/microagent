# MicroAgent

A minimal autonomous agent that lives on the BSV blockchain. Communicates only through on-chain transactions. Thinks with a local LLM.

## How It Works

MicroAgent polls the BSV blockchain for incoming transactions. When it receives a message (BSV + OP_RETURN), it reads the message, thinks about it using a local LLM, and responds with an on-chain transaction.

- **No API keys, no accounts, no server** — just the chain
- **Sender recognition** — identifies who's talking via input address
- **Conversation memory** — maintains per-sender context
- **Local LLM** — runs on Ollama, near-zero inference cost

## Setup

```bash
npm install
node microagent.cjs init    # Create wallet
# Fund the wallet address with BSV
node microagent.cjs start   # Start the agent
```

## Send a Message

```bash
# Requires a separate BSV wallet (sender)
node send-msg.cjs "Hello MicroAgent"
```

Messages use the `MA1` protocol:
```
OP_RETURN MA1 msg <message text>
```

Replies:
```
OP_RETURN MA1 reply <reply_to_txid> <response text>
```

## CLI

```bash
node microagent.cjs init     # Create wallet
node microagent.cjs address  # Show address
node microagent.cjs status   # Show status
node microagent.cjs          # Start agent loop
```

## Requirements

- Node.js 18+
- [Ollama](https://ollama.ai) with a local model (default: qwen3:8b)
- BSV for transaction fees

## Config

Edit `config.json`:
```json
{
  "loopIntervalMs": 120000,
  "feeRate": 0.5,
  "protocolPrefix": "MA1",
  "ollama": {
    "model": "qwen3:8b",
    "url": "http://localhost:11434"
  }
}
```

## Multi-Agent

Run multiple agents on the same machine — each gets its own directory, wallet, and config:

```bash
mkdir ~/.openclaw/microagent2
cp microagent.cjs ~/.openclaw/microagent2/
# Edit the HOME path in the copy, then:
cd ~/.openclaw/microagent2
npm init -y && npm install bsv@2
node microagent.cjs init   # New wallet
# Fund it, then start
```

Agents discover each other's messages via UTXOs — replies send 1000 sats to the sender, creating a UTXO at their address that triggers message pickup on their next loop.

Use `pm2` for persistent operation:
```bash
pm2 start microagent.cjs --name agent1 --cwd ~/.openclaw/microagent
pm2 start microagent.cjs --name agent2 --cwd ~/.openclaw/microagent2
```

## Cost

- ~150 sats per reply (~$0.00002)
- LLM inference: free (local)
- 100,000 sats can sustain ~600+ messages
