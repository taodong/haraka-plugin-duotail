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

  describe('extractDkimDomains', function () {
    const sig = (signingDomain, result) => ({
      signingDomain,
      status: { result },
    })

    it('returns an empty list when there are no results', function () {
      assert.deepEqual(this.plugin.extractDkimDomains(undefined), [])
      assert.deepEqual(this.plugin.extractDkimDomains({}), [])
      assert.deepEqual(
        this.plugin.extractDkimDomains({ dkim: { results: [] } }),
        [],
      )
    })

    it('returns an empty list when mailauth stored an error', function () {
      assert.deepEqual(
        this.plugin.extractDkimDomains({ dkim: { error: new Error('boom') } }),
        [],
      )
    })

    it('returns the signing domain of a passing signature', function () {
      assert.deepEqual(
        this.plugin.extractDkimDomains({
          dkim: { results: [sig('duotail.com', 'pass')] },
        }),
        ['duotail.com'],
      )
    })

    it('keeps only passing signatures', function () {
      assert.deepEqual(
        this.plugin.extractDkimDomains({
          dkim: {
            results: [
              sig('attacker.example', 'pass'),
              sig('duotail.com', 'fail'),
              sig('neutral.example', 'neutral'),
            ],
          },
        }),
        ['attacker.example'],
      )
    })

    it('lower-cases and de-duplicates domains', function () {
      assert.deepEqual(
        this.plugin.extractDkimDomains({
          dkim: {
            results: [
              sig('LinkedIn.com', 'pass'),
              sig('linkedin.com', 'pass'),
              sig('maile.linkedin.com', 'pass'),
            ],
          },
        }),
        ['linkedin.com', 'maile.linkedin.com'],
      )
    })

    it('skips a passing result without a signing domain', function () {
      assert.deepEqual(
        this.plugin.extractDkimDomains({
          dkim: { results: [{ status: { result: 'pass' } }] },
        }),
        [],
      )
    })
  })

  describe('parseHeaderFrom', function () {
    const withFrom = (from) => buildTransaction({ headers: { From: from } })

    it('parses a display name and address', function () {
      assert.deepEqual(
        this.plugin.parseHeaderFrom(
          withFrom('"Tao Dong" <tao.dong@duotail.com>\n'),
        ),
        {
          original: '<tao.dong@duotail.com>',
          original_host: 'duotail.com',
          host: 'duotail.com',
          user: 'tao.dong',
        },
      )
    })

    it('parses a bare address', function () {
      assert.deepEqual(this.plugin.parseHeaderFrom(withFrom('a@b.com')), {
        original: '<a@b.com>',
        original_host: 'b.com',
        host: 'b.com',
        user: 'a',
      })
    })

    it('lower-cases host but keeps original_host as written', function () {
      const contact = this.plugin.parseHeaderFrom(
        withFrom('Someone <Some.One@Duotail.COM>'),
      )
      assert.equal(contact.host, 'duotail.com')
      assert.equal(contact.original_host, 'Duotail.COM')
      assert.equal(contact.original, '<Some.One@Duotail.COM>')
    })

    it('takes the first mailbox when several are listed', function () {
      assert.equal(
        this.plugin.parseHeaderFrom(withFrom('first@a.com, second@b.com'))
          .original,
        '<first@a.com>',
      )
    })

    it('takes the first mailbox of a group', function () {
      assert.equal(
        this.plugin.parseHeaderFrom(withFrom('team: a@b.com, c@d.com;'))
          .original,
        '<a@b.com>',
      )
    })

    it('returns null for a group with no mailbox', function () {
      assert.equal(
        this.plugin.parseHeaderFrom(withFrom('undisclosed-recipients:;')),
        null,
      )
    })

    it('returns null when the header is missing or empty', function () {
      assert.equal(this.plugin.parseHeaderFrom(buildTransaction()), null)
      assert.equal(this.plugin.parseHeaderFrom(withFrom('')), null)
      assert.equal(this.plugin.parseHeaderFrom(undefined), null)
    })

    it('returns null for an unparseable header', function () {
      assert.equal(this.plugin.parseHeaderFrom(withFrom('garbage <<<')), null)
    })
  })

  describe('cache_and_save', function () {
    it('publishes headerFrom and dkimDomains in the Kafka message', function (done) {
      const plugin = this.plugin
      const sent = []
      plugin.cfg = {
        main: { enabled: true },
        kafka: { topic: 'test', messageVersion: 'test', messageType: 'T' },
        hazelcast: { cacheMapName: 'm', emailIdCacheMapName: 'ids' },
      }
      plugin.kafkaProducer = {
        send: async ({ messages }) => {
          sent.push(...messages)
        },
      }
      plugin.connectCacheServer = async () => {}
      plugin.hzClient = {
        getMap: async () => ({
          containsKey: async () => false,
          put: async () => {},
        }),
      }

      const headers = {
        From: '"Tao Dong" <tao.dong@duotail.com>\n',
        Subject: 'hi\n',
        'In-Reply-To': '',
        'Message-ID': '<id-1@example.com>\n',
      }
      const transaction = buildTransaction({ headers })
      transaction.header.get_all = (name) =>
        headers[name] === undefined ? [] : [headers[name]]
      transaction.notes = {
        get: () => ({
          spf: { status: { result: 'pass' } },
          dkim: {
            results: [
              { signingDomain: 'Duotail.com', status: { result: 'pass' } },
            ],
          },
        }),
      }
      transaction.rcpt_to = []
      transaction.message_stream = { uuid: 'u', pipe: () => {} }

      const connection = {
        transaction,
        remote: { ip: '10.0.0.1', host: 'remote' },
        hello: { host: 'helo' },
        local: { ip: '10.0.0.2', host: 'local' },
        loginfo: () => {},
        logerror: (e) => done(e),
      }

      plugin.cache_and_save(() => {
        try {
          assert.equal(sent.length, 1)
          const body = JSON.parse(sent[0].value)
          assert.deepEqual(body.headerFrom, {
            original: '<tao.dong@duotail.com>',
            original_host: 'duotail.com',
            host: 'duotail.com',
            user: 'tao.dong',
          })
          assert.deepEqual(body.dkimDomains, ['duotail.com'])
          assert.equal(body.dkimCheck, 'pass')
          done()
        } catch (e) {
          done(e)
        }
      }, connection)
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
