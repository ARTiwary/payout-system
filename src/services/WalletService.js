class WalletService {
  constructor({ walletTxRepo }) {
    this.walletTxRepo = walletTxRepo;
  }

  async getBalance(userId) {
    return this.walletTxRepo.balanceOf(userId);
  }

  async getStatement(userId) {
    return this.walletTxRepo.findByUser(userId);
  }
}

module.exports = { WalletService };
