'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { requireRole } = require('../src/middleware/auth');
const csrfMiddleware = require('../src/middleware/csrf');

test('RBAC Middleware: Restricts Administrator routes from Viewers', () => {
  const adminOnly = requireRole('Administrator');

  let statusSent = null;
  let viewRendered = null;
  const mockRes = {
    status: (code) => {
      statusSent = code;
      return mockRes;
    },
    render: (view) => {
      viewRendered = view;
      return mockRes;
    }
  };

  // Case 1: Viewer tries to access
  const reqViewer = {
    session: { userId: 2, role: 'Viewer' },
    path: '/settings',
    originalUrl: '/settings',
    ip: '127.0.0.1'
  };

  let nextCalled = false;
  adminOnly(reqViewer, mockRes, () => { nextCalled = true; });

  assert.equal(nextCalled, false, 'Viewer must not proceed to Administrator route');
  assert.equal(statusSent, 403);
  assert.equal(viewRendered, 'layouts/main');

  // Case 2: Administrator accesses
  let adminNextCalled = false;
  const reqAdmin = {
    session: { userId: 1, role: 'Administrator' },
    path: '/settings',
    originalUrl: '/settings',
    ip: '127.0.0.1'
  };

  adminOnly(reqAdmin, mockRes, () => { adminNextCalled = true; });
  assert.equal(adminNextCalled, true, 'Administrator must be permitted');
});

test('CSRF Middleware: Validates token on state-changing methods', () => {
  // GET request passes without token
  let getPassed = false;
  const getReq = { method: 'GET', path: '/events', session: {} };
  const mockRes = { locals: {} };
  csrfMiddleware(getReq, mockRes, () => { getPassed = true; });
  assert.equal(getPassed, true);

  // POST request without matching token fails with 403
  let postStatus = null;
  const failRes = {
    locals: {},
    status: (code) => {
      postStatus = code;
      return failRes;
    },
    render: () => failRes
  };

  let postPassed = false;
  const postReq = {
    method: 'POST',
    path: '/settings',
    session: { csrfToken: 'valid-secret-token' },
    body: { _csrf: 'wrong-token' },
    headers: {}
  };

  csrfMiddleware(postReq, failRes, () => { postPassed = true; });
  assert.equal(postPassed, false);
  assert.equal(postStatus, 403);

  // POST with valid token passes
  let validPostPassed = false;
  const validPostReq = {
    method: 'POST',
    path: '/settings',
    session: { csrfToken: 'valid-secret-token' },
    body: { _csrf: 'valid-secret-token' },
    headers: {}
  };

  csrfMiddleware(validPostReq, failRes, () => { validPostPassed = true; });
  assert.equal(validPostPassed, true);
});
