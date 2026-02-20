/**
 * Send BSV Skill
 * Command: [SEND <amount_sats> <address>]
 * 
 * When sending to the conversation partner, sats are embedded in the reply tx (no extra tx needed).
 * When sending to a third party, a separate tx is created.
 */

module.exports = {
  name: 'send-bsv',
  description: 'Send BSV to an address. Usage: [SEND <amount_sats> <address>]',
  pattern: /\[SEND\s+(\d+)\s+(1[a-km-zA-HJ-NP-Z1-9]{25,34})\]/g,

  prompt() {
    return 'You can send BSV using: [SEND <amount_sats> <address>]. Example: [SEND 500 1ABC...]. Max 10000 sats per send. Only send when explicitly asked or when it makes sense.';
  },

  parse(text) {
    const actions = [];
    let match;
    const re = new RegExp(this.pattern.source, this.pattern.flags);
    while ((match = re.exec(text)) !== null) {
      const amount = parseInt(match[1], 10);
      const address = match[2];
      if (amount >= 100 && amount <= 10000) {
        actions.push({ amount, address, raw: match[0] });
      }
    }
    return actions;
  },

  strip(text) {
    return text.replace(this.pattern, '').replace(/\s{2,}/g, ' ').trim();
  },

  // Only called for third-party sends (not conversation partner)
  async execute(action, { wallet, sendBsv, log }) {
    const { amount, address } = action;
    if (address === wallet.address) return { success: false, error: 'Cannot send to self' };
    try {
      const result = await sendBsv(wallet, amount, address);
      return { success: true, txid: result.txid, fee: result.fee };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
