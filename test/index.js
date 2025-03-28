'use strict'

const assert = require('assert')
const { describe, it, beforeEach } = require('mocha')

// npm modules
const fixtures = require('haraka-test-fixtures')

// start of tests
//    assert: https://nodejs.org/api/assert.html

describe('duotail', function () {
  beforeEach(function () {
    this.plugin = new fixtures.plugin('duotail')
  })

  it('loads', function () {
    assert.ok(this.plugin)
  })

  describe('load_duotail_ini', function () {
    it('loads duotail.ini from config/duotail.ini', function () {
      this.configfile = {
        main: {
          enabled: false,
        },
      }

      // eslint-disable-next-line no-unused-vars
      this.plugin.config.get = function (_file, _type) {
        return this.configfile
      }.bind(this)
      this.plugin.load_duotail_ini()
      assert.ok(this.plugin.cfg !== undefined)
    })

    it('initializes enabled boolean', function (done) {
      this.configfile = {
      main: {
        enabled: true,
      },
      kafka: {
        messageVersion: 'test',
        brokers: 'localhost:9092,localhost:9093',
        topic: 'test',
        producerTimeout: 100,
        connectTimeout: 100,
      },
      hazelcast: {
        clusterName: 'test',
        clusterMembers: 'localhost:5701',
        connectTimeout: 100,
        reconnectMode: 'OFF',
        clusterConnectionTimeout: 1000,
      },
      }

      // eslint-disable-next-line no-unused-vars
      this.plugin.config.get = function (_file, _type) {
      return this.configfile
      }.bind(this)

      this.plugin.load_duotail_ini();
      this.plugin.shutdown();
      assert.equal(this.plugin.cfg.main.enabled, true, this.plugin.cfg);
      done()
    })
  })

  describe('uses text fixtures', function () {
    it('sets up a connection', function () {
      this.connection = fixtures.connection.createConnection({})
      assert.ok(this.connection.server)
    })

    it('sets up a transaction', function () {
      this.configfile = {
        kafka: {
          messageVersion: 'test',
          brokers: 'localhost:9092',
          topic: 'test',
          producerTimeout: 100,
          connectTimeout: 100,
        },
        hazelcast: {
          clusterName: 'test',
          clusterMembers: 'localhost:5701',
          cacheMapName: 'test',
          connectTimeout: 100,
          reconnectMode: 'OFF',
        },
      }

      // eslint-disable-next-line no-unused-vars
      this.plugin.config.get = function (_file, _type) {
        return this.configfile
      }.bind(this)

      this.connection = fixtures.connection.createConnection({})
      this.connection.init_transaction()
      assert.ok(this.connection.transaction.header)
    })
  })
})
