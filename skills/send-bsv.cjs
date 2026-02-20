/**
 * Send BSV Skill
 * Command: [SEND <amount_sats> <address>]
 * Allows the agent to send sats to any BSV address.
 */

module.exports = {
  name: 'send-bsv',
  description: 'Send BSV to an address. Usage: [SEND <amount_sats> <address>]',
  pattern: /\[SEND\s+(\d+)\s+(1[a-km-zA-HJ-NP-Z1-9]{25,34})\]/g,

  // Called by agent to get system prompt addition
  prompt() {
    return 'You can send BSV using: [SEND <amount_sats> <address>]. Example: [SEND 500 1ABC...]. Max 10000 sats per send. Only send when explicitly asked or when it makes sense.';
  },

  // Parse commands from LLM response, return array of actions
  parse(text) {
    const actions = [];
    let match;
    const re = new RegExp(this.pattern.source, this.pattern.flags);
    while ((match = re.exec(text)) !== null) {
      const amount = parseInt(match[1], 10);
      const address = match[2];
      actions.push({ amount, address, raw: match[0] });
    }
    return actions;
  },

  // Strip commands from text (for on-chain message)
  strip(text) {
    return text.replace(this.pattern, '').replace(/\s{2,}/g, ' ').trim();
  },

  // Execute a single action. Returns { success, txid?, error? }
  async execute(action, { wallet, sendBsv, log }) {
    const { amount, address } = action;

    // Safety limits
    if (amount < 100) return { success: false, error: 'Amount too small (min 100 sats)' };
    if (amount > 10000) return { success: false, error: 'Amount too large (max 10000 sats)' };
    if (address === wallet.address) return { success: false, error: 'Cannot send to self' };

    try {
      const result = await sendBsv(wallet, amount, address);
      log(`SKILL send-bsv: sent ${amount} sats to ${address} | txid: ${result.txid}`);
      return { success: true, txid: result.txid, fee: result.fee };
    } catch (e) {
      log(`SKILL send-bsv ERROR: ${e.message}`);
      return { success: false, error: e.message };
    }
  }
};
