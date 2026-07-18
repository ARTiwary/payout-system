const { Withdrawal, WithdrawalStatus, RECOVERABLE_STATUSES } = require('../models/Withdrawal');
const { WalletTransaction, TransactionType } = require('../models/WalletTransaction');
const { round2 } = require('../repositories/InMemoryRepository');

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

class WithdrawalError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WithdrawalError';
    this.code = code;
  }
}

class WithdrawalService {
  constructor({ withdrawalRepo, walletTxRepo, now = () => new Date() }) {
    this.withdrawalRepo = withdrawalRepo;
    this.walletTxRepo = walletTxRepo;
    this.now = now; // injectable clock, makes the 24h rule testable
  }

  /**
   * Business rule: "A user can make only one payout withdrawal every
   * 24 hours."
   *
   * We interpret this as: the user is blocked only while their most
   * recent withdrawal is still "live" — i.e. requested in the last
   * 24h AND not in a recoverable terminal state (failed / cancelled /
   * rejected). A recoverable withdrawal means the money never
   * actually reached the user, so per the Failed Payout Recovery
   * requirement ("allow the user to initiate another withdrawal for
   * that amount") it must NOT count against the throttle.
   */
  async _isThrottled(userId) {
    const withdrawals = await this.withdrawalRepo.findByUser(userId); // newest first
    const last = withdrawals[0];
    if (!last) return { throttled: false };

    const isRecoverable = RECOVERABLE_STATUSES.has(last.status);
    if (isRecoverable) return { throttled: false };

    const elapsed = this.now().getTime() - last.requestedAt.getTime();
    if (elapsed < TWENTY_FOUR_HOURS_MS) {
      const retryAfterMs = TWENTY_FOUR_HOURS_MS - elapsed;
      return { throttled: true, retryAfterMs, last };
    }
    return { throttled: false };
  }

  /**
   * Initiates a withdrawal. Defaults to withdrawing the full
   * available balance if `amount` is not given.
   */
  async initiate(userId, amount = null) {
    const throttle = await this._isThrottled(userId);
    if (throttle.throttled) {
      throw new WithdrawalError(
        `Only one withdrawal is allowed every 24 hours. Try again in ${Math.ceil(
          throttle.retryAfterMs / (60 * 1000)
        )} minute(s).`,
        'THROTTLED'
      );
    }

    const balance = await this.walletTxRepo.balanceOf(userId);
    const withdrawAmount = amount === null ? balance : round2(amount);

    if (withdrawAmount <= 0) {
      throw new WithdrawalError('Withdrawal amount must be greater than 0.', 'INVALID_AMOUNT');
    }
    if (withdrawAmount > balance) {
      throw new WithdrawalError(
        `Insufficient withdrawable balance. Available: ₹${balance}, requested: ₹${withdrawAmount}.`,
        'INSUFFICIENT_BALANCE'
      );
    }

    const withdrawal = new Withdrawal({ userId, amount: withdrawAmount });
    withdrawal.requestedAt = this.now(); // respect injectable clock (real clock by default)
    await this.withdrawalRepo.save(withdrawal);

    const debitTx = new WalletTransaction({
      userId,
      type: TransactionType.WITHDRAWAL,
      amount: -withdrawAmount,
      withdrawalId: withdrawal.id,
    });
    await this.walletTxRepo.save(debitTx);

    return withdrawal;
  }

  /**
   * Updates a withdrawal's status (e.g. from a payment-gateway
   * webhook: success / failed / cancelled / rejected). If the new
   * status is a recoverable failure, the previously-debited amount is
   * credited straight back to the user's withdrawable balance
   * (Question 2: Failed Payout Recovery), and — because the throttle
   * check ignores recoverable withdrawals — the user can immediately
   * initiate a new withdrawal for that amount.
   */
  async updateStatus(withdrawalId, newStatus) {
    if (!Object.values(WithdrawalStatus).includes(newStatus)) {
      throw new WithdrawalError(`Invalid withdrawal status "${newStatus}".`, 'INVALID_STATUS');
    }

    const withdrawal = await this.withdrawalRepo.findById(withdrawalId);
    if (!withdrawal) {
      throw new WithdrawalError(`Withdrawal ${withdrawalId} not found`, 'NOT_FOUND');
    }
    if (withdrawal.status !== WithdrawalStatus.INITIATED) {
      throw new WithdrawalError(
        `Withdrawal ${withdrawalId} is already in a terminal state ("${withdrawal.status}").`,
        'ALREADY_SETTLED'
      );
    }

    withdrawal.status = newStatus;
    withdrawal.settledAt = this.now();
    await this.withdrawalRepo.save(withdrawal);

    if (RECOVERABLE_STATUSES.has(newStatus)) {
      const reversalTx = new WalletTransaction({
        userId: withdrawal.userId,
        type: TransactionType.WITHDRAWAL_REVERSAL,
        amount: withdrawal.amount,
        withdrawalId: withdrawal.id,
      });
      await this.walletTxRepo.save(reversalTx);
    }

    return withdrawal;
  }
}

module.exports = { WithdrawalService, WithdrawalError, TWENTY_FOUR_HOURS_MS };
