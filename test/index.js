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

      this.plugin.load_duotail_ini()
      this.plugin.shutdown()
      assert.equal(this.plugin.cfg.main.enabled, true, this.plugin.cfg)
      done()
    })
  })

  const buildTransaction = (isaResult, contentType) => ({
    results: { get: () => isaResult },
    header: { get: () => contentType },
  })

  describe('extractBounceResult', function () {
    const dsrContentType = 'multipart/report; report-type=delivery-status'

    // haraka-plugin-bounce 2.2.x stores isa as mail_from.isNull() (number 1),
    // older/other versions use boolean true or the string 'yes'. All are bounces.
    for (const isa of [1, true, 'yes']) {
      it(`returns true when flagged (isa=${JSON.stringify(isa)}) and Content-Type is a delivery-status report`, function () {
        const transaction = buildTransaction({ isa }, dsrContentType)
        assert.equal(this.plugin.extractBounceResult(transaction), true)
      })
    }

    it('returns false for an auto-responder (null sender but text/plain)', function () {
      const transaction = buildTransaction({ isa: 1 }, 'text/plain')
      assert.equal(this.plugin.extractBounceResult(transaction), false)
    })

    it('returns false when Content-Type header is missing', function () {
      const transaction = buildTransaction({ isa: 1 }, undefined)
      assert.equal(this.plugin.extractBounceResult(transaction), false)
    })

    it('returns false for an MDN read-receipt (disposition-notification)', function () {
      const transaction = buildTransaction(
        { isa: 1 },
        'multipart/report; report-type=disposition-notification',
      )
      assert.equal(this.plugin.extractBounceResult(transaction), false)
    })

    // isNull() returns 0 for a real sender; 'no'/false are the older equivalents.
    for (const isa of [0, false, 'no']) {
      it(`returns false when haraka-plugin-bounce did not flag it (isa=${JSON.stringify(isa)})`, function () {
        const transaction = buildTransaction({ isa }, dsrContentType)
        assert.equal(this.plugin.extractBounceResult(transaction), false)
      })
    }

    it('returns false when haraka-plugin-bounce is not installed', function () {
      const transaction = buildTransaction(undefined, dsrContentType)
      assert.equal(this.plugin.extractBounceResult(transaction), false)
    })
  })

  describe('isDeliveryStatusReport', function () {
    it('matches a folded, quoted, mixed-case Content-Type', function () {
      const transaction = buildTransaction(
        undefined,
        'Multipart/Report;\n\treport-type="delivery-status";\n\tboundary="abc"',
      )
      assert.equal(this.plugin.isDeliveryStatusReport(transaction), true)
    })

    it('does not match multipart/report without delivery-status report-type', function () {
      const transaction = buildTransaction(undefined, 'multipart/report')
      assert.equal(this.plugin.isDeliveryStatusReport(transaction), false)
    })

    it('returns false when the header is missing', function () {
      const transaction = buildTransaction(undefined, undefined)
      assert.equal(this.plugin.isDeliveryStatusReport(transaction), false)
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
