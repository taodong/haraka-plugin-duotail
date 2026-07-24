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

  // A minimal MIME part: content type plus optional decoded text and children.
  const part = (ct, { bodytext = '', children = [] } = {}) => ({
    ct,
    bodytext,
    children,
  })

  // A transaction double. mail_from exposes isNull() like Haraka's Address;
  // headers is a plain map of header name -> value.
  const buildTransaction = ({
    nullSender = false,
    body = null,
    headers = {},
  } = {}) => {
    const lookup = {}
    for (const [k, v] of Object.entries(headers)) lookup[k.toLowerCase()] = v
    return {
      mail_from: { isNull: () => nullSender },
      body,
      header: { get: (name) => lookup[String(name).toLowerCase()] },
    }
  }

  const deliveryStatus = (statusText) =>
    part('multipart/report; report-type=delivery-status', {
      children: [
        part('text/plain', {
          bodytext: 'Your message could not be delivered.',
        }),
        part('message/delivery-status', {
          bodytext: `Reporting-MTA: dns; mail.example.com\n\nFinal-Recipient: rfc822; user@example.com\nAction: failed\n${statusText}\n`,
        }),
        part('message/rfc822', {
          bodytext: 'Status: 2.0.0 (decoy in original)',
        }),
      ],
    })

  describe('classifyInbound', function () {
    it('classifies a hard bounce (5.x.x) as DSN with the status code', function () {
      const transaction = buildTransaction({
        nullSender: true,
        body: deliveryStatus('Status: 5.1.1'),
      })
      assert.deepEqual(this.plugin.classifyInbound(transaction), {
        inboundType: 'DSN',
        bounceStatus: '5.1.1',
      })
    })

    it('classifies a soft bounce (4.x.x) as DSN with the status code', function () {
      const transaction = buildTransaction({
        nullSender: true,
        body: deliveryStatus('Status: 4.4.1'),
      })
      assert.deepEqual(this.plugin.classifyInbound(transaction), {
        inboundType: 'DSN',
        bounceStatus: '4.4.1',
      })
    })

    it('classifies a success DSN (2.x.x) as DSN, not a bounce', function () {
      const transaction = buildTransaction({
        nullSender: true,
        body: deliveryStatus('Status: 2.0.0'),
      })
      assert.deepEqual(this.plugin.classifyInbound(transaction), {
        inboundType: 'DSN',
        bounceStatus: '2.0.0',
      })
    })

    it('reads Status only from the delivery-status part, ignoring the embedded original', function () {
      const transaction = buildTransaction({
        nullSender: true,
        body: deliveryStatus('Status: 5.7.1'),
      })
      assert.equal(
        this.plugin.classifyInbound(transaction).bounceStatus,
        '5.7.1',
      )
    })

    it('returns DSN with null status when the code is unparseable (malformed DSN)', function () {
      const body = part('multipart/report; report-type=delivery-status', {
        children: [
          part('message/delivery-status', { bodytext: 'Action: failed\n' }),
        ],
      })
      const transaction = buildTransaction({ nullSender: true, body })
      assert.deepEqual(this.plugin.classifyInbound(transaction), {
        inboundType: 'DSN',
        bounceStatus: null,
      })
    })

    it('is not a DSN when the delivery-status part exists but the sender is not null', function () {
      const transaction = buildTransaction({
        nullSender: false,
        body: deliveryStatus('Status: 5.1.1'),
      })
      assert.equal(
        this.plugin.classifyInbound(transaction).inboundType,
        'NORMAL',
      )
    })

    it('classifies a disposition-notification report as MDN', function () {
      const body = part(
        'multipart/report; report-type=disposition-notification',
        {
          children: [
            part('message/disposition-notification', { bodytext: '' }),
          ],
        },
      )
      const transaction = buildTransaction({ body })
      assert.deepEqual(this.plugin.classifyInbound(transaction), {
        inboundType: 'MDN',
        bounceStatus: null,
      })
    })

    it('classifies Auto-Submitted: auto-replied as AUTO_REPLY (even with a null sender)', function () {
      const transaction = buildTransaction({
        nullSender: true,
        headers: { 'Auto-Submitted': 'auto-replied' },
      })
      assert.deepEqual(this.plugin.classifyInbound(transaction), {
        inboundType: 'AUTO_REPLY',
        bounceStatus: null,
      })
    })

    it('parses Auto-Submitted with parameters (auto-replied; ...)', function () {
      const transaction = buildTransaction({
        headers: { 'Auto-Submitted': 'auto-replied; charset=utf-8' },
      })
      assert.equal(
        this.plugin.classifyInbound(transaction).inboundType,
        'AUTO_REPLY',
      )
    })

    for (const h of ['X-Autoreply', 'X-Autorespond']) {
      it(`classifies vendor header ${h} as AUTO_REPLY`, function () {
        const transaction = buildTransaction({ headers: { [h]: 'yes' } })
        assert.equal(
          this.plugin.classifyInbound(transaction).inboundType,
          'AUTO_REPLY',
        )
      })
    }

    it('classifies Auto-Submitted: auto-generated as AUTO_GENERATED', function () {
      const transaction = buildTransaction({
        headers: { 'Auto-Submitted': 'auto-generated' },
      })
      assert.equal(
        this.plugin.classifyInbound(transaction).inboundType,
        'AUTO_GENERATED',
      )
    })

    for (const p of ['bulk', 'list', 'junk']) {
      it(`classifies Precedence: ${p} as AUTO_GENERATED`, function () {
        const transaction = buildTransaction({ headers: { Precedence: p } })
        assert.equal(
          this.plugin.classifyInbound(transaction).inboundType,
          'AUTO_GENERATED',
        )
      })
    }

    it('does not classify X-Auto-Response-Suppress as automated (directive, not marker)', function () {
      const transaction = buildTransaction({
        headers: { 'X-Auto-Response-Suppress': 'OOF, AutoReply' },
      })
      assert.equal(
        this.plugin.classifyInbound(transaction).inboundType,
        'NORMAL',
      )
    })

    it('classifies ordinary mail as NORMAL', function () {
      const transaction = buildTransaction({
        body: part('text/plain', { bodytext: 'hello' }),
        headers: { From: 'a@b.com' },
      })
      assert.deepEqual(this.plugin.classifyInbound(transaction), {
        inboundType: 'NORMAL',
        bounceStatus: null,
      })
    })

    it('classifies an auto-reply ahead of a bulk Precedence', function () {
      const transaction = buildTransaction({
        headers: { 'Auto-Submitted': 'auto-replied', Precedence: 'bulk' },
      })
      assert.equal(
        this.plugin.classifyInbound(transaction).inboundType,
        'AUTO_REPLY',
      )
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
