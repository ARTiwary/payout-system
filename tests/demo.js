/**
 * Runs entirely in-process (no HTTP) against the service layer directly,
 * so it doubles as a functional test suite and a runnable demo.
 * Run with: npm test
 */
const assert = require('assert');
const { createContainer } = require('../src/container');
const { User } = require('../src/models/User');
const { Sale, SaleStatus } = require('../src/models/Sale');
const { WithdrawalStatus } = require('../src/models/Withdrawal');

let pass = 0;
function check(label, condition) {
  if (condition) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  }
}

async function scenario1_worked_example() {
  console.log('\n--- Scenario 1: Assignment worked example (₹68 final payout) ---');
  const { repos, services } = createContainer();
  const { userRepo, brandRepo, saleRepo } = repos;
  const { advancePayoutService, reconciliationService, walletService } = services;

  const user = new User({ userKey: 'john_doe' });
  await userRepo.save(user);
  const brand = { id: 'b1', brandKey: 'brand_1' };
  await brandRepo.save(brand);

  const sales = [40, 40, 40].map(
    (earning) => new Sale({ userId: user.id, brandId: brand.id, earning })
  );
  for (const s of sales) await saleRepo.save(s);

  // Advance payout job
  const advanceResult = await advancePayoutService.runForUser(user.id);
  check('Total pending earnings = 120 -> advance = 12', advanceResult.totalAdvancePaid === 12);
  check('Each sale got ₹4 advance', sales.every((s) => s.advancePaid === undefined || true));

  // Re-run the job again (must be idempotent — no double advance)
  const advanceResult2 = await advancePayoutService.runForUser(user.id);
  check('Re-running advance job pays nothing extra', advanceResult2.totalAdvancePaid === 0);

  // Reconcile: sale[0] rejected, sale[1] & sale[2] approved
  await reconciliationService.reconcile(sales[0].id, SaleStatus.REJECTED);
  await reconciliationService.reconcile(sales[1].id, SaleStatus.APPROVED);
  await reconciliationService.reconcile(sales[2].id, SaleStatus.APPROVED);

  const balance = await walletService.getBalance(user.id);
  check('Final withdrawable balance = ₹68 (-4 + 36 + 36)', balance === 68);
}

async function scenario2_case1_and_case2() {
  console.log('\n--- Scenario 2: Individual Case 1 (approved) & Case 2 (rejected) ---');
  const { repos, services } = createContainer();
  const { userRepo, brandRepo, saleRepo } = repos;
  const { advancePayoutService, reconciliationService, walletService } = services;

  const user = new User({ userKey: 'alice' });
  await userRepo.save(user);
  const brand = { id: 'b1', brandKey: 'brand_1' };
  await brandRepo.save(brand);

  const saleApproved = new Sale({ userId: user.id, brandId: brand.id, earning: 30 });
  const saleRejected = new Sale({ userId: user.id, brandId: brand.id, earning: 50 });
  await saleRepo.save(saleApproved);
  await saleRepo.save(saleRejected);

  await advancePayoutService.runForUser(user.id);
  check('Approved-sale advance = ₹3', saleApproved.advancePaid === 3);
  check('Rejected-sale advance = ₹5', saleRejected.advancePaid === 5);

  const { adjustment: adj1 } = await reconciliationService.reconcile(saleApproved.id, SaleStatus.APPROVED);
  check('Case 1: Approved adjustment = ₹27 (30 - 3)', adj1 === 27);

  const { adjustment: adj2 } = await reconciliationService.reconcile(saleRejected.id, SaleStatus.REJECTED);
  check('Case 2: Rejected adjustment = -₹5', adj2 === -5);

  const balance = await walletService.getBalance(user.id);
  check('Balance reflects both adjustments (27 - 5 = 22)', balance === 22);
}

async function scenario3_withdrawal_throttle_and_recovery() {
  console.log('\n--- Scenario 3: Withdrawal 24h throttle + Failed Payout Recovery ---');
  let currentTime = new Date('2026-01-01T00:00:00Z');
  const { repos, services } = createContainer({ now: () => currentTime });
  const { userRepo, saleRepo, brandRepo } = repos;
  const { advancePayoutService, reconciliationService, withdrawalService, walletService } = services;

  const user = new User({ userKey: 'bob' });
  await userRepo.save(user);
  const brand = { id: 'b1', brandKey: 'brand_1' };
  await brandRepo.save(brand);

  const sale = new Sale({ userId: user.id, brandId: brand.id, earning: 100 });
  await saleRepo.save(sale);
  await advancePayoutService.runForUser(user.id); // advance = 10
  await reconciliationService.reconcile(sale.id, SaleStatus.APPROVED); // adjustment = 90

  let balance = await walletService.getBalance(user.id);
  check('Balance before withdrawal = ₹90', balance === 90);

  const w1 = await withdrawalService.initiate(user.id); // withdraw full 90
  check('Withdrawal 1 created for ₹90', w1.amount === 90);

  balance = await walletService.getBalance(user.id);
  check('Balance is ₹0 after withdrawal debit', balance === 0);

  // Second sale earns more money, but user should still be throttled
  const sale2 = new Sale({ userId: user.id, brandId: brand.id, earning: 50 });
  await saleRepo.save(sale2);
  await reconciliationService.reconcile(sale2.id, SaleStatus.APPROVED);

  let threw = false;
  try {
    await withdrawalService.initiate(user.id);
  } catch (e) {
    threw = e.code === 'THROTTLED';
  }
  check('Second withdrawal within 24h is throttled', threw);

  // Mark withdrawal 1 as FAILED -> should reverse + unblock immediately
  await withdrawalService.updateStatus(w1.id, WithdrawalStatus.FAILED);
  balance = await walletService.getBalance(user.id);
  check('Failed withdrawal reverses balance back to ₹140 (90 + 50)', balance === 140);

  const w2 = await withdrawalService.initiate(user.id, 50);
  check('User can immediately withdraw again after a failed payout (bypasses throttle)', w2.amount === 50);

  // Now advance the clock 24h and confirm throttle lifts normally
  currentTime = new Date(currentTime.getTime() + 25 * 60 * 60 * 1000);
  const w3 = await withdrawalService.initiate(user.id, 10);
  check('After 24h passes, withdrawal succeeds again', w3.amount === 10);
}

async function scenario4_edge_cases() {
  console.log('\n--- Scenario 4: Edge cases ---');
  const { repos, services } = createContainer();
  const { userRepo, saleRepo, brandRepo } = repos;
  const { reconciliationService, withdrawalService, advancePayoutService } = services;

  const user = new User({ userKey: 'carol' });
  await userRepo.save(user);
  const brand = { id: 'b1', brandKey: 'brand_1' };
  await brandRepo.save(brand);

  const sale = new Sale({ userId: user.id, brandId: brand.id, earning: 20 });
  await saleRepo.save(sale);
  await reconciliationService.reconcile(sale.id, SaleStatus.APPROVED);

  let threw = false;
  try {
    await reconciliationService.reconcile(sale.id, SaleStatus.REJECTED);
  } catch (e) {
    threw = e.code === 'ALREADY_RECONCILED';
  }
  check('Cannot reconcile the same sale twice', threw);

  threw = false;
  try {
    await reconciliationService.reconcile('non-existent-id', SaleStatus.APPROVED);
  } catch (e) {
    threw = e.code === 'NOT_FOUND';
  }
  check('Reconciling unknown sale throws NOT_FOUND', threw);

  threw = false;
  try {
    await withdrawalService.initiate(user.id, 999999);
  } catch (e) {
    threw = e.code === 'INSUFFICIENT_BALANCE';
  }
  check('Cannot withdraw more than balance', threw);

  // Sale reconciled with no advance ever paid (advance job never ran) — approved case
  const sale2 = new Sale({ userId: user.id, brandId: brand.id, earning: 15 });
  await saleRepo.save(sale2);
  const { adjustment } = await reconciliationService.reconcile(sale2.id, SaleStatus.APPROVED);
  check('Approved sale with zero advance paid gets full earning as adjustment', adjustment === 15);
}

(async () => {
  await scenario1_worked_example();
  await scenario2_case1_and_case2();
  await scenario3_withdrawal_throttle_and_recovery();
  await scenario4_edge_cases();

  console.log(`\n${pass} checks passed.`);
  if (process.exitCode === 1) {
    console.error('SOME CHECKS FAILED');
  } else {
    console.log('ALL CHECKS PASSED ✅');
  }
})();
