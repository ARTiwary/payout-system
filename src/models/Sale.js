const { v4: uuid } = require('uuid');

const SaleStatus = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
});

class Sale {
  constructor({ userId, brandId, earning, status = SaleStatus.PENDING }) {
    this.id = uuid();
    this.userId = userId;
    this.brandId = brandId;
    this.earning = earning;
    this.status = status;

    this.advancePaid = 0;        // amount already transferred as advance
    this.advancePaidAt = null;

    this.reconciledAt = null;
    this.finalAdjustment = null; // computed once, at reconciliation

    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  get isEligibleForAdvance() {
    // Core idempotency guard: a sale can receive an advance only while
    // still pending AND only if it has never received one before.
    return this.status === SaleStatus.PENDING && this.advancePaidAt === null;
  }

  get isReconciled() {
    return this.status !== SaleStatus.PENDING;
  }
}

module.exports = { Sale, SaleStatus };
