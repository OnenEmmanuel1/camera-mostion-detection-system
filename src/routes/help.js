'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { config } = require('../config');

const router = express.Router();

router.get('/help', requireAuth, (req, res) => {
  res.render('layouts/main', {
    pageTitle: 'Documentation & Help - ISSS',
    view: 'help/index',
    config,
    activeNav: 'help'
  });
});

module.exports = router;
