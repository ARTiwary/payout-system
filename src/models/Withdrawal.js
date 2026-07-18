const { v4: uuid } = require('uuid');

const WithdrawalStatus = Object.freeze({
  INITIATED: 'initiated',
  SUCCESS: 'success',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  REJECTED: 'rejected',
});

// Terminal statuses that mean "the money never actually left / didn't
// stick with the user" and therefore must be reversed + must not count
// against the 24h withdrawal-throttle window.
const RECOVERABLE_STATUSES = new Set([
  WithdrawalStatus.FAILED,
  WithdrawalStatus.CANCELLED,
  WithdrawalStatus.REJECTED,
]);

class Withdrawal {
  constructor({ userId, amount }) {
    this.id = uuid();
    this.userId = userId;
    this.amount = amount;
    this.status = WithdrawalStatus.INITIATED;
    this.requestedAt = new Date();
    this.settledAt = null;
  }
}

module.exports = { Withdrawal, WithdrawalStatus, RECOVERABLE_STATUSES };
