const express = require('express');
const { User } = require('../models/User');
const { Sale, SaleStatus } = require('../models/Sale');

function buildRouter(container) {
  const router = express.Router();
  const { userRepo, brandRepo, saleRepo } = container.repos;
  const { advancePayoutService, reconciliationService, walletService, withdrawalService } =
    container.services;

  const asyncHandler = (fn) => (req, res) => fn(req, res).catch((err) => handleError(res, err));

  function handleError(res, err) {
    const status =
      err.code === 'NOT_FOUND'
        ? 404
        : err.code
        ? 400
        : 500;
    res.status(status).json({ error: err.message || 'Internal server error', code: err.code });
  }

  // ---- helpers -----------------------------------------------------
  async function getOrCreateUser(userKey) {
    let user = await userRepo.findByKey(userKey);
    if (!user) {
      user = new User({ userKey });
      await userRepo.save(user);
    }
    return user;
  }

  async function getOrCreateBrand(brandKey) {
    let brand = await brandRepo.findByKey(brandKey);
    if (!brand) {
      brand = { id: require('uuid').v4(), brandKey, createdAt: new Date() };
      await brandRepo.save(brand);
    }
    return brand;
  }

  // ---- Sales ---------------------------------------------------------
  // POST /sales  { userId, brand, earning }
  router.post(
    '/sales',
    asyncHandler(async (req, res) => {
      const { userId, brand: brandKey, earning } = req.body;
      if (!userId || !brandKey || typeof earning !== 'number' || earning < 0) {
        return res.status(400).json({ error: 'userId, brand and a non-negative numeric earning are required.' });
      }
      const user = await getOrCreateUser(userId);
      const brand = await getOrCreateBrand(brandKey);

      const sale = new Sale({ userId: user.id, brandId: brand.id, earning });
      await saleRepo.save(sale);
      res.status(201).json(serializeSale(sale, user, brand));
    })
  );

  // GET /sales?userId=john_doe
  router.get(
    '/sales',
    asyncHandler(async (req, res) => {
      const { userId } = req.query;
      let sales = await saleRepo.findAll();
      if (userId) {
        const user = await userRepo.findByKey(userId);
        sales = user ? sales.filter((s) => s.userId === user.id) : [];
      }
      res.json(sales);
    })
  );

  // POST /sales/:id/reconcile { status: 'approved' | 'rejected' }
  router.post(
    '/sales/:id/reconcile',
    asyncHandler(async (req, res) => {
      const { status } = req.body;
      const { sale, adjustment } = await reconciliationService.reconcile(req.params.id, status);
      res.json({ sale, adjustment });
    })
  );

  // ---- Advance payout job --------------------------------------------
  // POST /jobs/advance-payout { userId }
  router.post(
    '/jobs/advance-payout',
    asyncHandler(async (req, res) => {
      const { userId: userKey } = req.body;
      const user = await getOrCreateUser(userKey);
      const result = await advancePayoutService.runForUser(user.id);
      res.json(result);
    })
  );

  // ---- Wallet ----------------------------------------------------------
  // GET /users/:userKey/wallet
  router.get(
    '/users/:userKey/wallet',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateUser(req.params.userKey);
      const balance = await walletService.getBalance(user.id);
      res.json({ userId: user.userKey, withdrawableBalance: balance });
    })
  );

  // GET /users/:userKey/transactions
  router.get(
    '/users/:userKey/transactions',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateUser(req.params.userKey);
      const txns = await walletService.getStatement(user.id);
      res.json(txns);
    })
  );

  // ---- Withdrawals -------------------------------------------------------
  // POST /users/:userKey/withdraw { amount? }
  router.post(
    '/users/:userKey/withdraw',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateUser(req.params.userKey);
      const withdrawal = await withdrawalService.initiate(user.id, req.body.amount ?? null);
      res.status(201).json(withdrawal);
    })
  );

  // POST /withdrawals/:id/status { status: 'success'|'failed'|'cancelled'|'rejected' }
  router.post(
    '/withdrawals/:id/status',
    asyncHandler(async (req, res) => {
      const withdrawal = await withdrawalService.updateStatus(req.params.id, req.body.status);
      res.json(withdrawal);
    })
  );

  return router;
}

function serializeSale(sale, user, brand) {
  return { ...sale, userKey: user.userKey, brandKey: brand.brandKey };
}

module.exports = { buildRouter };
