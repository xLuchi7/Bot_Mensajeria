const { Router } = require('express');
const { validateMetaSignature } = require('../middleware/verifySignature');
const controller = require('../controllers/webhookController');

const router = Router();

// Single endpoint (all platforms)
router.get('/', controller.verify);
router.post('/', validateMetaSignature, controller.handleMessage);

// Platform-specific aliases — Meta lets you register any URL,
// these all funnel to the same handlers
router.get('/instagram', controller.verify);
router.post('/instagram', validateMetaSignature, controller.handleMessage);

router.get('/whatsapp', controller.verify);
router.post('/whatsapp', validateMetaSignature, controller.handleMessage);

router.get('/facebook', controller.verify);
router.post('/facebook', validateMetaSignature, controller.handleMessage);

module.exports = router;
