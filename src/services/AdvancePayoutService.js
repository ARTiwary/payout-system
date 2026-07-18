const { TransactionType } = require('../models/WalletTransaction');
const { WalletTransaction } = require('../models/WalletTransaction');
const { round2 } = require('../repositories/InMemoryRepository');

const ADVANCE_RATE = 0.10;

class AdvancePayoutService {
  constructor({ saleRepo, walletTxRepo }) {
    this.saleRepo = saleRepo;
    this.walletTxRepo = walletTxRepo;
  }

  /**
   * Runs the advance payout job for a single user.
   *
   * Idempotency: only sales that are still `pending` AND have never
   * had an advance paid (`advancePaidAt === null`) are picked up. As
   * soon as a sale is processed we flip advancePaidAt in the SAME
   * synchronous pass, so re-running this job (even many times back to
   * back) never double-pays a sale. In a real DB this is the
   * guarantee given by the conditional UPDATE described in schema.sql.
   *
   * Advance payout is modeled as money actually transferred to the
   * user immediately (outside the withdrawable-balance ledger) — it
   * is NOT something the user has to "withdraw" separately. We still
   * write an ADVANCE_PAYOUT ledger row for audit/history purposes,
   * but it does not affect the withdrawable balance. Only the later
   * RECONCILIATION_ADJUSTMENT (earning - advance, or -advance) touches
   * the withdrawable balance. This matches the worked example in the
   * assignment, where the ₹12 advance is paid out up front and the
   * final payout of ₹68 is calculated purely from reconciliation
   * adjustments.
   */
  async runForUser(userId) {
    const eligibleSales = await this.saleRepo.findPendingWithoutAdvance(userId);

    const results = [];
    for (const sale of eligibleSales) {
      // Re-check eligibility right before mutating — guards against
      // the same sale being processed twice within one job run if the
      // caller passed duplicate ids, etc.
      if (!sale.isEligibleForAdvance) continue;

      const advanceAmount = round2(sale.earning * ADVANCE_RATE);
      sale.advancePaid = advanceAmount;
      sale.advancePaidAt = new Date();
      sale.updatedAt = new Date();
      await this.saleRepo.save(sale);

      const tx = new WalletTransaction({
        userId,
        type: TransactionType.ADVANCE_PAYOUT,
        amount: advanceAmount,
        saleId: sale.id,
      });
      await this.walletTxRepo.save(tx);

      results.push({ saleId: sale.id, advancePaid: advanceAmount });
    }

    return {
      userId,
      processedCount: results.length,
      totalAdvancePaid: round2(results.reduce((s, r) => s + r.advancePaid, 0)),
      details: results,
    };
  }
}

module.exports = { AdvancePayoutService, ADVANCE_RATE };
