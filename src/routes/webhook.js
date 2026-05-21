const { Router } = require('express');
const { validateMetaSignature } = require('../middleware/verifySignature');
const controller = require('../controllers/webhookController');

const router = Router();

router.get('/', controller.verify);
router.post('/', validateMetaSignature, controller.handleMessage);

module.exports = router;
