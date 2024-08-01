'use strict';

const assert = require('assert');
const { describe, it, beforeEach } = require('mocha');

// npm modules
const fixtures = require('haraka-test-fixtures');

// start of tests
//    assert: https://nodejs.org/api/assert.html

describe('duotail', function() {
  beforeEach(function() {
    this.plugin = new fixtures.plugin('duotail');
  });

  it('loads', function() {
    assert.ok(this.plugin);
  });

  describe('load_duotail_ini', function() {
    it('loads duotail.ini from config/duotail.ini', function() {
      this.plugin.load_duotail_ini();
      assert.ok(this.plugin.cfg !== undefined);
    });

    it('initializes enabled boolean', function() {
      this.plugin.load_duotail_ini();
      assert.equal(this.plugin.cfg.main.enabled, true, this.plugin.cfg);
    });
  });

  describe('uses text fixtures', function() {
    it('sets up a connection', function() {
      this.connection = fixtures.connection.createConnection({});
      assert.ok(this.connection.server);
    });

    it('sets up a transaction', function() {
      this.connection = fixtures.connection.createConnection({});
      this.connection.init_transaction();
      assert.ok(this.connection.transaction.header);
    });
  });
});
