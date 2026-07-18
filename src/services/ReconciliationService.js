const { SaleStatus } = require('../models/Sale');
const { WalletTransaction, TransactionType } = require('../models/WalletTransaction');
const { round2 } = require('../repositories/InMemoryRepository');

class ReconciliationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ReconciliationError';
    this.code = code;
  }
}

class ReconciliationService {
  constructor({ saleRepo, walletTxRepo }) {
    this.saleRepo = saleRepo;
    this.walletTxRepo = walletTxRepo;
  }

  /**
   * Admin reconciles one sale to APPROVED or REJECTED.
   *
   * Case 1 (Approved):  adjustment = earning - advancePaid   (can be
   *   the full earning if no advance was ever paid, e.g. the job
   *   hadn't run yet).
   * Case 2 (Rejected):  adjustment = -advancePaid  (claw back
   *   whatever was advanced; 0 if nothing was advanced).
   *
   * The adjustment is written once as a RECONCILIATION_ADJUSTMENT
   * ledger row and `sale.finalAdjustment` is frozen for audit — a
   * sale can only be reconciled once (guarded by isReconciled).
   */
  async reconcile(saleId, newStatus) {
    if (![SaleStatus.APPROVED, SaleStatus.REJECTED].includes(newStatus)) {
      throw new ReconciliationError(
        `Invalid target status "${newStatus}". Must be "approved" or "rejected".`,
        'INVALID_STATUS'
      );
    }

    const sale = await this.saleRepo.findById(saleId);
    if (!sale) {
      throw new ReconciliationError(`Sale ${saleId} not found`, 'NOT_FOUND');
    }
    if (sale.isReconciled) {
      throw new ReconciliationError(
        `Sale ${saleId} was already reconciled as "${sale.status}"`,
        'ALREADY_RECONCILED'
      );
    }

    const adjustment =
      newStatus === SaleStatus.APPROVED
        ? round2(sale.earning - sale.advancePaid)
        : round2(-sale.advancePaid);

    sale.status = newStatus;
    sale.reconciledAt = new Date();
    sale.finalAdjustment = adjustment;
    sale.updatedAt = new Date();
    await this.saleRepo.save(sale);

    const tx = new WalletTransaction({
      userId: sale.userId,
      type: TransactionType.RECONCILIATION_ADJUSTMENT,
      amount: adjustment,
      saleId: sale.id,
    });
    await this.walletTxRepo.save(tx);

    return { sale, adjustment };
  }
}

module.exports = { ReconciliationService, ReconciliationError };
