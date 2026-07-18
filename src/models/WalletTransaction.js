const { v4: uuid } = require('uuid');

const TransactionType = Object.freeze({
  ADVANCE_PAYOUT: 'ADVANCE_PAYOUT',
  RECONCILIATION_ADJUSTMENT: 'RECONCILIATION_ADJUSTMENT',
  WITHDRAWAL: 'WITHDRAWAL',
  WITHDRAWAL_REVERSAL: 'WITHDRAWAL_REVERSAL',
});

class WalletTransaction {
  constructor({ userId, type, amount, saleId = null, withdrawalId = null }) {
    this.id = uuid();
    this.userId = userId;
    this.type = type;
    this.amount = amount; // signed: credit is positive, debit is negative
    this.saleId = saleId;
    this.withdrawalId = withdrawalId;
    this.createdAt = new Date();
  }
}

module.exports = { WalletTransaction, TransactionType };
