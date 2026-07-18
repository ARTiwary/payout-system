class BaseRepository {
  constructor() {
    this.store = new Map();
  }
  async save(entity) {
    this.store.set(entity.id, entity);
    return entity;
  }
  async findById(id) {
    return this.store.get(id) || null;
  }
  async findAll() {
    return Array.from(this.store.values());
  }
}

class UserRepository extends BaseRepository {
  async findByKey(userKey) {
    return this.findAllSync().find((u) => u.userKey === userKey) || null;
  }
  findAllSync() {
    return Array.from(this.store.values());
  }
}

class BrandRepository extends BaseRepository {
  async findByKey(brandKey) {
    return this.findAllSync().find((b) => b.brandKey === brandKey) || null;
  }
  findAllSync() {
    return Array.from(this.store.values());
  }
}

class SaleRepository extends BaseRepository {
  async findByUser(userId) {
    return this.findAllSync().filter((s) => s.userId === userId);
  }
  async findPendingWithoutAdvance(userId) {
    return this.findAllSync().filter(
      (s) => s.userId === userId && s.isEligibleForAdvance
    );
  }
  findAllSync() {
    return Array.from(this.store.values());
  }
}

class WalletTransactionRepository extends BaseRepository {
  async findByUser(userId) {
    return this.findAllSync()
      .filter((t) => t.userId === userId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  async balanceOf(userId) {
    // ADVANCE_PAYOUT rows are audit-only: that money is transferred to
    // the user immediately and directly, outside the withdrawable
    // balance, so it must not be double-counted here. Only
    // reconciliation adjustments, withdrawals, and withdrawal
    // reversals affect what the user can withdraw.
    const txns = await this.findByUser(userId);
    return round2(
      txns
        .filter((t) => t.type !== 'ADVANCE_PAYOUT')
        .reduce((sum, t) => sum + t.amount, 0)
    );
  }
  findAllSync() {
    return Array.from(this.store.values());
  }
}

class WithdrawalRepository extends BaseRepository {
  async findByUser(userId) {
    return this.findAllSync()
      .filter((w) => w.userId === userId)
      .sort((a, b) => b.requestedAt - a.requestedAt);
  }
  findAllSync() {
    return Array.from(this.store.values());
  }
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

module.exports = {
  UserRepository,
  BrandRepository,
  SaleRepository,
  WalletTransactionRepository,
  WithdrawalRepository,
  round2,
};
