'use strict';

function isEnterpriseMode() {
  return process.env.ENTERPRISE_MODE === 'true';
}

module.exports = { isEnterpriseMode };
