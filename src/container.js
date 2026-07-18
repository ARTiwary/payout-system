const {
  UserRepository,
  BrandRepository,
  SaleRepository,
  WalletTransactionRepository,
  WithdrawalRepository,
} = require('./repositories/InMemoryRepository');

const { AdvancePayoutService } = require('./services/AdvancePayoutService');
const { ReconciliationService } = require('./services/ReconciliationService');
const { WalletService } = require('./services/WalletService');
const { WithdrawalService } = require('./services/WithdrawalService');

/**
 * Builds a fresh, wired-up set of repositories + services.
 * Kept as a factory (rather than a singleton) so tests can spin up
 * an isolated instance each time.
 */
function createContainer({ now } = {}) {
  const userRepo = new UserRepository();
  const brandRepo = new BrandRepository();
  const saleRepo = new SaleRepository();
  const walletTxRepo = new WalletTransactionRepository();
  const withdrawalRepo = new WithdrawalRepository();

  const advancePayoutService = new AdvancePayoutService({ saleRepo, walletTxRepo });
  const reconciliationService = new ReconciliationService({ saleRepo, walletTxRepo });
  const walletService = new WalletService({ walletTxRepo });
  const withdrawalService = new WithdrawalService({
    withdrawalRepo,
    walletTxRepo,
    ...(now ? { now } : {}),
  });

  return {
    repos: { userRepo, brandRepo, saleRepo, walletTxRepo, withdrawalRepo },
    services: { advancePayoutService, reconciliationService, walletService, withdrawalService },
  };
}

module.exports = { createContainer };
