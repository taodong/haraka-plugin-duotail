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
  // headers is a plain map of header name -> value, or an array of values for a
  // repeated header. Like Haraka, get joins repeated values with "\n".
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
      header: {
        get_all: (name) => {
          const value = lookup[String(name).toLowerCase()]
          if (value === undefined) return []
          return Array.isArray(value) ? value : [value]
        },
        get(name) {
          const values = this.get_all(name)
          return values.length ? values.join('\n') : undefined
        },
      },
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

  describe('extractDmarcResult', function () {
    const sig = (signingDomain, result) => ({
      signingDomain,
      status: { result },
    })
    const spf = (domain, result) => ({ domain, status: { result } })
    // A mailauth DMARC note for a domain with a record, alignment already computed.
    const recorded = (result, domain, policy, dkim, spfDomain) => ({
      status: { result },
      domain,
      policy,
      alignment: { dkim: { result: dkim }, spf: { result: spfDomain } },
    })
    // A mailauth DMARC note for no record (none) or a failed lookup (temperror): no alignment.
    const unrecorded = (result, domain) => ({ status: { result }, domain })

    it('returns null when DMARC did not run, threw or saw several From addresses', function () {
      assert.equal(this.plugin.extractDmarcResult(undefined), null)
      assert.equal(this.plugin.extractDmarcResult({}), null)
      assert.equal(
        this.plugin.extractDmarcResult({ dmarc: { error: new Error('boom') } }),
        null,
      )
      assert.equal(this.plugin.extractDmarcResult({ dmarc: false }), null)
    })

    it('copies a pass with DKIM alignment', function () {
      assert.deepEqual(
        this.plugin.extractDmarcResult({
          dmarc: recorded('pass', 'Company.com', 'quarantine', 'Company.com'),
        }),
        {
          result: 'pass',
          domain: 'company.com',
          policy: 'quarantine',
          dkimAligned: 'company.com',
          spfAligned: null,
        },
      )
    })

    it('copies a pass with SPF alignment only', function () {
      assert.deepEqual(
        this.plugin.extractDmarcResult({
          dmarc: recorded(
            'pass',
            'ted.com',
            'reject',
            undefined,
            'bounce.ted.com',
          ),
        }),
        {
          result: 'pass',
          domain: 'ted.com',
          policy: 'reject',
          dkimAligned: null,
          spfAligned: 'bounce.ted.com',
        },
      )
    })

    for (const policy of ['none', 'quarantine', 'reject']) {
      it(`copies a fail with policy ${policy}`, function () {
        assert.deepEqual(
          this.plugin.extractDmarcResult({
            dkim: { results: [sig('paypal.com', 'fail')] },
            dmarc: recorded('fail', 'paypal.com', policy),
          }),
          {
            result: 'fail',
            domain: 'paypal.com',
            policy,
            dkimAligned: null,
            spfAligned: null,
          },
        )
      })
    }

    for (const result of ['none', 'temperror']) {
      describe(`${result}: alignment computed by the plugin`, function () {
        const extract = (plugin, domain, authResults) =>
          plugin.extractDmarcResult({
            ...authResults,
            dmarc: unrecorded(result, domain),
          })

        it('aligns a passing DKIM domain', function () {
          assert.deepEqual(
            extract(this.plugin, 'small.co', {
              dkim: {
                results: [sig('evil.com', 'pass'), sig('Small.co', 'pass')],
              },
            }),
            {
              result,
              domain: 'small.co',
              policy: null,
              dkimAligned: 'small.co',
              spfAligned: null,
            },
          )
        })

        it('ignores a DKIM domain that did not pass', function () {
          assert.equal(
            extract(this.plugin, 'small.co', {
              dkim: { results: [sig('small.co', 'fail')] },
            }).dkimAligned,
            null,
          )
        })

        it('aligns the envelope domain when SPF passed', function () {
          assert.equal(
            extract(this.plugin, 'small.co', { spf: spf('small.co', 'pass') })
              .spfAligned,
            'small.co',
          )
        })

        it('does not align an unaligned SPF domain', function () {
          assert.equal(
            extract(this.plugin, 'small.co', { spf: spf('evil.com', 'pass') })
              .spfAligned,
            null,
          )
        })

        it('does not align the envelope domain when SPF failed', function () {
          assert.equal(
            extract(this.plugin, 'small.co', { spf: spf('small.co', 'fail') })
              .spfAligned,
            null,
          )
        })

        it('aligns sibling subdomains through the organizational domain', function () {
          const dmarc = extract(this.plugin, 'ted.org', {
            spf: spf('bounce.ted.org', 'pass'),
            dkim: { results: [sig('news.ted.org', 'pass')] },
          })
          assert.equal(dmarc.spfAligned, 'bounce.ted.org')
          assert.equal(dmarc.dkimAligned, 'news.ted.org')
        })

        it('aligns nothing without a passing domain', function () {
          assert.deepEqual(
            extract(this.plugin, 'small.co', {
              spf: spf('evil.com', 'pass'),
              dkim: { results: [sig('evil.com', 'pass')] },
            }),
            {
              result,
              domain: 'small.co',
              policy: null,
              dkimAligned: null,
              spfAligned: null,
            },
          )
        })
      })
    }
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

    it('unfolds a From header split across lines', function () {
      assert.equal(
        this.plugin.parseHeaderFrom(
          withFrom('"A very long display name here"\n <a@b.com>\n'),
        ).original,
        '<a@b.com>',
      )
    })

    it('keeps quoted punctuation in the local part', function () {
      assert.deepEqual(
        this.plugin.parseHeaderFrom(
          withFrom('Sender <":sysmail"@example.com>'),
        ),
        {
          original: '<":sysmail"@example.com>',
          original_host: 'example.com',
          host: 'example.com',
          user: '":sysmail"',
        },
      )
    })

    it('keeps repeated spaces in a quoted local part', function () {
      const contact = this.plugin.parseHeaderFrom(
        withFrom('S <"a  b"@example.com>'),
      )
      assert.equal(contact.original, '<"a  b"@example.com>')
      assert.equal(contact.user, '"a  b"')
    })

    it('matches the shape Haraka gives mail_from', function () {
      const { Address } = require('address-rfc2821')
      const from = '"Sender" <"john.doe"@Example.COM>'
      assert.equal(
        JSON.stringify(this.plugin.parseHeaderFrom(withFrom(from))),
        JSON.stringify(new Address('<"john.doe"@Example.COM>')),
      )
    })

    it('returns null for repeated From headers', function () {
      // An attacker can prepend an unsigned From to a replayed signed message.
      assert.equal(
        this.plugin.parseHeaderFrom(
          withFrom(['1_attacker@duotail.com\n', 'postmaster@duotail.com\n']),
        ),
        null,
      )
    })

    it('returns null when an empty From header follows a real one', function () {
      assert.equal(
        this.plugin.parseHeaderFrom(withFrom(['a@b.com\n', ''])),
        null,
      )
    })

    it('returns null when an empty From header precedes a real one', function () {
      assert.equal(
        this.plugin.parseHeaderFrom(withFrom(['', 'a@b.com\n'])),
        null,
      )
    })

    it('treats a trailing newline as a single From header', function () {
      assert.equal(
        this.plugin.parseHeaderFrom(withFrom('only@a.com\n')).original,
        '<only@a.com>',
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

  describe('parseHeaderRecipients', function () {
    const addresses = (plugin, headers) =>
      plugin
        .parseHeaderRecipients(buildTransaction({ headers }))
        .map((a) => `${a.user}@${a.host}`)

    it('lists To before Cc, in header order', function () {
      assert.deepEqual(
        addresses(this.plugin, {
          To: 'X <1_ch_fi@duotail.com>, 3_Y_at_example.com@duotail.com\n',
          Cc: '"Long" <4_abcdefgh_1@duotail.com>\n',
        }),
        [
          '1_ch_fi@duotail.com',
          '3_Y_at_example.com@duotail.com',
          '4_abcdefgh_1@duotail.com',
        ],
      )
    })

    it('builds each mailbox like headerFrom, keeping the local part case', function () {
      assert.deepEqual(
        this.plugin.parseHeaderRecipients(
          buildTransaction({ headers: { To: 'Y <3_Y_at_X.com@Duotail.com>' } }),
        ),
        [
          {
            original: '<3_Y_at_X.com@Duotail.com>',
            original_host: 'Duotail.com',
            host: 'duotail.com',
            user: '3_Y_at_X.com',
          },
        ],
      )
    })

    it('reads every instance of a header', function () {
      assert.deepEqual(
        addresses(this.plugin, { Cc: ['a@x.com\n', 'b@x.com\n'] }),
        ['a@x.com', 'b@x.com'],
      )
    })

    it('flattens a group and unfolds folded lines', function () {
      assert.deepEqual(
        addresses(this.plugin, {
          To: 'team: a@x.com,\n b@x.com;, c@x.com\n',
        }),
        ['a@x.com', 'b@x.com', 'c@x.com'],
      )
    })

    it('leaves out an address that is not a valid mailbox', function () {
      assert.deepEqual(
        addresses(this.plugin, { To: 'ok@x.com, "a b"@[300.1.1.1]\n' }),
        ['ok@x.com'],
      )
    })

    it('returns an empty list without To or Cc, or for an unparseable one', function () {
      assert.deepEqual(addresses(this.plugin, {}), [])
      assert.deepEqual(addresses(this.plugin, { To: '\n', Cc: '<<<' }), [])
    })
  })

  describe('cache_and_save', function () {
    it('publishes headerFrom and dmarc in the Kafka message', function (done) {
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
          putIfAbsent: async () => null,
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
      transaction.notes = {
        get: () => ({
          spf: { status: { result: 'pass' } },
          dkim: {
            results: [
              { signingDomain: 'Duotail.com', status: { result: 'pass' } },
            ],
          },
          dmarc: {
            status: { result: 'pass' },
            domain: 'duotail.com',
            policy: 'quarantine',
            alignment: {
              dkim: { result: 'Duotail.com' },
              spf: { result: false },
            },
          },
        }),
      }
      transaction.rcpt_to = [{ user: 'a', host: 'duotail.com' }]
      transaction.message_stream = {
        uuid: 'u',
        pipe: (destination) => destination.end('raw'),
      }

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
          assert.deepEqual(body.dmarc, {
            result: 'pass',
            domain: 'duotail.com',
            policy: 'quarantine',
            dkimAligned: 'duotail.com',
            spfAligned: null,
          })
          assert.deepEqual(body.headerRecipients, [])
          assert.ok(!('spfCheck' in body))
          assert.ok(!('dkimCheck' in body))
          assert.ok(!('dkimDomains' in body))
          done()
        } catch (e) {
          done(e)
        }
      }, connection)
    })
  })

  describe('cache_and_save rejectUnaligned', function () {
    const { Address } = require('address-rfc2821')
    const constants = require('haraka-constants')

    const sig = (signingDomain, result) => ({
      signingDomain,
      status: { result },
    })
    const unaligned = (result, domain, policy) => ({
      status: { result },
      domain,
      policy,
      alignment: { dkim: { result: false }, spf: { result: false } },
    })
    // The forged PayPal email of the design: signed and SPF-passed by evil.com only.
    const forged = (dmarc) => ({
      spf: { domain: 'evil.com', status: { result: 'pass' } },
      dkim: { results: [sig('evil.com', 'pass')] },
      dmarc,
    })

    const setUp = (plugin, rejectUnaligned) => {
      const env = { sent: [], cached: [] }
      plugin.cfg = {
        main: { enabled: true },
        auth: { rejectUnaligned },
        kafka: { topic: 'test', messageVersion: 'test', messageType: 'T' },
        hazelcast: { cacheMapName: 'cache', emailIdCacheMapName: 'ids' },
      }
      plugin.kafkaProducer = {
        send: async ({ messages }) => {
          env.sent.push(...messages)
        },
      }
      plugin.connectCacheServer = async () => {}
      plugin.hzClient = {
        getMap: async () => ({
          putIfAbsent: async () => null,
          put: async (key) => {
            env.cached.push(key)
          },
        }),
      }
      return env
    }

    const connectionFor = (
      authResults,
      {
        recipient = '1_tao.dong_bzdv@duotail.com',
        headers = {},
        mailFrom,
      } = {},
    ) => {
      const lookup = {
        from: 'PayPal <service@paypal.com>\n',
        subject: 'hi\n',
        'in-reply-to': '',
        'message-id': '<mid-1@evil.com>\n',
      }
      for (const [name, value] of Object.entries(headers)) {
        lookup[name.toLowerCase()] = value
      }
      const transaction = {
        mail_from: new Address(mailFrom ?? '<bounce@evil.com>'),
        rcpt_to: [new Address(`<${recipient}>`)],
        body: null,
        notes: { get: () => authResults },
        header: {
          get_all: (name) => {
            const value = lookup[String(name).toLowerCase()]
            return value === undefined ? [] : [value]
          },
          get(name) {
            return this.get_all(name).join('\n')
          },
        },
        message_stream: {
          uuid: 'u',
          pipe: (destination) => destination.end('raw message'),
        },
      }
      return {
        transaction,
        remote: { ip: '10.0.0.1', host: 'remote' },
        hello: { host: 'helo' },
        local: { ip: '10.0.0.2', host: 'local' },
        logged: [],
        loginfo(_plugin, message) {
          this.logged.push(message)
        },
        logerror: () => {},
      }
    }

    // Runs cache_and_save and resolves with the arguments it passed to next.
    const save = (plugin, connection) =>
      new Promise((resolve) => {
        plugin.cache_and_save((...args) => resolve(args), connection)
      })

    const assertRefused = (env, args, code, prefix) => {
      assert.equal(args[0], code)
      assert.ok(
        args[1].startsWith(prefix),
        `"${args[1]}" does not start with "${prefix}"`,
      )
      assert.equal(env.sent.length, 0)
      assert.equal(env.cached.length, 0)
    }

    it('off: caches and publishes an unaligned email', async function () {
      const env = setUp(this.plugin, false)
      const args = await save(
        this.plugin,
        connectionFor(forged(unaligned('fail', 'paypal.com', 'reject'))),
      )
      assert.deepEqual(args, [])
      assert.equal(env.sent.length, 1)
      assert.equal(env.cached.length, 1)
    })

    it('off when the auth section is missing', async function () {
      const env = setUp(this.plugin, false)
      delete this.plugin.cfg.auth
      const args = await save(
        this.plugin,
        connectionFor(forged(unaligned('fail', 'paypal.com', 'reject'))),
      )
      assert.deepEqual(args, [])
      assert.equal(env.sent.length, 1)
    })

    it('on: continues when DKIM is aligned', async function () {
      const env = setUp(this.plugin, true)
      const args = await save(
        this.plugin,
        connectionFor({
          dkim: { results: [sig('company.com', 'pass')] },
          dmarc: {
            status: { result: 'pass' },
            domain: 'company.com',
            policy: 'quarantine',
            alignment: { dkim: { result: 'company.com' }, spf: {} },
          },
        }),
      )
      assert.deepEqual(args, [])
      assert.equal(env.sent.length, 1)
    })

    it('on: continues when only SPF is aligned (computed for none)', async function () {
      const env = setUp(this.plugin, true)
      const args = await save(
        this.plugin,
        connectionFor({
          spf: { domain: 'bounce.ted.org', status: { result: 'pass' } },
          dmarc: { status: { result: 'none' }, domain: 'ted.org' },
        }),
      )
      assert.deepEqual(args, [])
      assert.equal(env.sent.length, 1)
    })

    it('on: refuses a fail with 550 5.7.26 naming the domain', async function () {
      const env = setUp(this.plugin, true)
      const connection = connectionFor(
        forged(unaligned('fail', 'paypal.com', 'reject')),
      )
      const args = await save(this.plugin, connection)
      assertRefused(env, args, constants.deny, '5.7.26 ')
      assert.equal(
        args[1],
        '5.7.26 Message not accepted: the From domain paypal.com is not aligned with SPF or DKIM (DMARC)',
      )
      assert.equal(connection.logged.length, 1)
      assert.ok(connection.logged[0].includes('550 5.7.26'))
      assert.ok(connection.logged[0].includes('bounce@evil.com'))
      assert.ok(connection.logged[0].includes('service@paypal.com'))
      assert.ok(connection.logged[0].includes('1_tao.dong_bzdv@duotail.com'))
      assert.ok(connection.logged[0].includes('"result":"fail"'))
    })

    it('on: refuses an unaligned none with 550 5.7.26', async function () {
      const env = setUp(this.plugin, true)
      const args = await save(
        this.plugin,
        connectionFor(
          forged({ status: { result: 'none' }, domain: 'small.co' }),
          { headers: { From: 'ceo@small.co\n' } },
        ),
      )
      assertRefused(env, args, constants.deny, '5.7.26 ')
      assert.ok(args[1].includes('small.co'))
    })

    it('on: refuses an unaligned temperror with 450 4.7.0', async function () {
      const env = setUp(this.plugin, true)
      const args = await save(
        this.plugin,
        connectionFor(
          forged({ status: { result: 'temperror' }, domain: 'corp.com' }),
        ),
      )
      assertRefused(env, args, constants.denysoft, '4.7.0 ')
    })

    it('on: refuses several From addresses (dmarc false) with 550 5.7.1', async function () {
      const env = setUp(this.plugin, true)
      const args = await save(this.plugin, connectionFor(forged(false)))
      assertRefused(env, args, constants.deny, '5.7.1 ')
      assert.equal(
        args[1],
        '5.7.1 Message not accepted: exactly one From header is required',
      )
    })

    it('on: refuses a DMARC error with 450 4.7.0', async function () {
      const env = setUp(this.plugin, true)
      const args = await save(
        this.plugin,
        connectionFor(forged({ error: new Error('boom') })),
      )
      assertRefused(env, args, constants.denysoft, '4.7.0 ')
    })

    it('on: refuses a DKIM error with 450 4.7.0', async function () {
      const env = setUp(this.plugin, true)
      const args = await save(
        this.plugin,
        connectionFor({ dkim: { error: new Error('boom') } }),
      )
      assertRefused(env, args, constants.denysoft, '4.7.0 ')
    })

    it('on: refuses missing mailauth notes with 450 4.7.0', async function () {
      const env = setUp(this.plugin, true)
      const args = await save(this.plugin, connectionFor(undefined))
      assertRefused(env, args, constants.denysoft, '4.7.0 ')
    })

    it('on: refuses a missing DMARC note with 450 4.7.0', async function () {
      const env = setUp(this.plugin, true)
      const args = await save(this.plugin, connectionFor(forged(undefined)))
      assertRefused(env, args, constants.denysoft, '4.7.0 ')
    })

    it('on: continues for a DSN to a 0_ recipient, even when unaligned', async function () {
      const env = setUp(this.plugin, true)
      this.plugin.classifyInbound = () => ({
        inboundType: 'DSN',
        bounceStatus: '5.1.1',
      })
      const args = await save(
        this.plugin,
        connectionFor(
          forged({ status: { result: 'none' }, domain: 'small.co' }),
          {
            recipient: '0_abc@duotail.com',
            mailFrom: '<>',
          },
        ),
      )
      assert.deepEqual(args, [])
      assert.equal(env.sent.length, 1)
    })

    it('on: continues for an auto-reply to a 0_ recipient, even when unaligned', async function () {
      const env = setUp(this.plugin, true)
      const args = await save(
        this.plugin,
        connectionFor(forged(unaligned('fail', 'paypal.com', 'reject')), {
          recipient: '0_abc@duotail.com',
          headers: { 'Auto-Submitted': 'auto-replied\n' },
        }),
      )
      assert.deepEqual(args, [])
      assert.equal(env.sent.length, 1)
    })

    it('on: refuses an unaligned auto-reply to a masked recipient', async function () {
      const env = setUp(this.plugin, true)
      const args = await save(
        this.plugin,
        connectionFor(forged(unaligned('fail', 'paypal.com', 'reject')), {
          headers: { 'Auto-Submitted': 'auto-replied\n' },
        }),
      )
      assertRefused(env, args, constants.deny, '5.7.26 ')
    })

    it('on: refuses an unaligned normal email to a 0_ recipient', async function () {
      const env = setUp(this.plugin, true)
      const args = await save(
        this.plugin,
        connectionFor(forged(unaligned('fail', 'paypal.com', 'reject')), {
          recipient: '0_abc@duotail.com',
        }),
      )
      assertRefused(env, args, constants.deny, '5.7.26 ')
    })
  })

  describe('cache_and_save de-duplication', function () {
    const { Address } = require('address-rfc2821')
    const { Writable } = require('stream')

    // An in-memory stand-in for the Hazelcast maps: putIfAbsent is atomic, as in IMap.
    const memoryMap = () => {
      const entries = new Map()
      return {
        entries,
        putIfAbsent: async (key, value) => {
          if (entries.has(key)) return entries.get(key)
          entries.set(key, value)
          return null
        },
        put: async (key, value) => {
          entries.set(key, value)
        },
        remove: async (key) => {
          const value = entries.get(key)
          entries.delete(key)
          return value
        },
      }
    }

    const setUp = (plugin) => {
      const env = { sent: [], ids: memoryMap(), cache: memoryMap() }
      plugin.cfg = {
        main: { enabled: true },
        kafka: { topic: 'test', messageVersion: 'test', messageType: 'T' },
        hazelcast: { cacheMapName: 'cache', emailIdCacheMapName: 'ids' },
      }
      plugin.kafkaProducer = {
        send: async ({ messages }) => {
          env.sent.push(...messages)
        },
      }
      plugin.connectCacheServer = async () => {}
      plugin.hzClient = {
        getMap: async (name) => (name === 'ids' ? env.ids : env.cache),
      }
      return env
    }

    const connectionFor = (recipients, messageId = '<mid-1@gmail.com>\n') => {
      const lookup = {
        from: 'Sender <sender@gmail.com>\n',
        subject: 'hi\n',
        'in-reply-to': '',
        'message-id': messageId,
      }
      const transaction = {
        mail_from: new Address('<sender@gmail.com>'),
        rcpt_to: recipients.map((r) => new Address(`<${r}>`)),
        body: null,
        notes: { get: () => ({}) },
        header: {
          get_all: (name) => {
            const value = lookup[String(name).toLowerCase()]
            return value === undefined ? [] : [value]
          },
          get(name) {
            return this.get_all(name).join('\n')
          },
        },
        message_stream: {
          uuid: 'u',
          pipe: (destination) => destination.end('raw message'),
        },
      }
      return {
        transaction,
        remote: { ip: '10.0.0.1', host: 'remote' },
        hello: { host: 'helo' },
        local: { ip: '10.0.0.2', host: 'local' },
        loginfo: () => {},
        logerror: () => {},
      }
    }

    // Runs cache_and_save and resolves with the arguments it passed to next.
    const save = (plugin, connection) =>
      new Promise((resolve) => {
        plugin.cache_and_save((...args) => resolve(args), connection)
      })

    const sentRecipients = (message) =>
      JSON.parse(message.value).rcptTo.map((r) => `${r.user}@${r.host}`)

    it('forwards every recipient of a split email (observed Gmail reply-all)', async function () {
      const env = setUp(this.plugin)
      const first = await save(
        this.plugin,
        connectionFor(['1_tao.dong_bzdv@duotail.com']),
      )
      const second = await save(
        this.plugin,
        connectionFor(['3_wedgeup_at_gmail.com@duotail.com']),
      )
      assert.deepEqual(first, [])
      assert.deepEqual(second, [])
      assert.equal(env.sent.length, 2)
      assert.deepEqual(sentRecipients(env.sent[0]), [
        '1_tao.dong_bzdv@duotail.com',
      ])
      assert.deepEqual(sentRecipients(env.sent[1]), [
        '3_wedgeup_at_gmail.com@duotail.com',
      ])
    })

    it('publishes the To/Cc mailboxes, whatever the envelope', async function () {
      const env = setUp(this.plugin)
      const connection = connectionFor(['1_tao.dong_bzdv@duotail.com'])
      const get_all = connection.transaction.header.get_all
      connection.transaction.header.get_all = (name) =>
        name === 'To'
          ? [
              '1_tao.dong_bzdv@duotail.com, 3_wedgeup_at_gmail.com@duotail.com\n',
            ]
          : get_all(name)
      await save(this.plugin, connection)
      const body = JSON.parse(env.sent[0].value)
      assert.deepEqual(
        body.headerRecipients.map((r) => `${r.user}@${r.host}`),
        ['1_tao.dong_bzdv@duotail.com', '3_wedgeup_at_gmail.com@duotail.com'],
      )
    })

    it('forwards all recipients of one transaction in one message', async function () {
      const env = setUp(this.plugin)
      await save(
        this.plugin,
        connectionFor(['a@duotail.com', 'b@duotail.com', 'c@duotail.com']),
      )
      assert.equal(env.sent.length, 1)
      assert.deepEqual(sentRecipients(env.sent[0]), [
        'a@duotail.com',
        'b@duotail.com',
        'c@duotail.com',
      ])
      assert.deepEqual(
        [...env.ids.entries.keys()],
        [
          '<mid-1@gmail.com>|a@duotail.com',
          '<mid-1@gmail.com>|b@duotail.com',
          '<mid-1@gmail.com>|c@duotail.com',
        ],
      )
    })

    it('drops a repeat of the same delivery', async function () {
      const env = setUp(this.plugin)
      await save(this.plugin, connectionFor(['a@duotail.com']))
      const repeat = await save(this.plugin, connectionFor(['a@duotail.com']))
      assert.deepEqual(repeat, [])
      assert.equal(env.sent.length, 1)
      assert.equal(env.cache.entries.size, 1)
    })

    it('forwards only the new recipients of a partly repeated delivery', async function () {
      const env = setUp(this.plugin)
      await save(this.plugin, connectionFor(['a@duotail.com']))
      await save(this.plugin, connectionFor(['a@duotail.com', 'b@duotail.com']))
      assert.equal(env.sent.length, 2)
      assert.deepEqual(sentRecipients(env.sent[1]), ['b@duotail.com'])
    })

    it('treats recipients that differ only in case as the same', async function () {
      const env = setUp(this.plugin)
      await save(this.plugin, connectionFor(['3_Abc_at_x.com@duotail.com']))
      await save(this.plugin, connectionFor(['3_abc_at_x.com@duotail.com']))
      assert.equal(env.sent.length, 1)
    })

    it('forwards a recipient listed twice in one envelope once', async function () {
      const env = setUp(this.plugin)
      await save(this.plugin, connectionFor(['a@duotail.com', 'a@duotail.com']))
      assert.deepEqual(sentRecipients(env.sent[0]), ['a@duotail.com'])
    })

    it('lets exactly one of two concurrent transactions claim a recipient', async function () {
      const env = setUp(this.plugin)
      const results = await Promise.all([
        save(this.plugin, connectionFor(['a@duotail.com'])),
        save(this.plugin, connectionFor(['a@duotail.com'])),
      ])
      assert.deepEqual(results, [[], []])
      assert.equal(env.sent.length, 1)
    })

    it('does not de-duplicate an email without a Message-ID', async function () {
      const env = setUp(this.plugin)
      await save(this.plugin, connectionFor(['a@duotail.com'], ''))
      await save(this.plugin, connectionFor(['a@duotail.com'], ''))
      assert.equal(env.sent.length, 2)
      assert.equal(env.ids.entries.size, 0)
    })

    it('publishes the summary only after the cache write finished', async function () {
      const env = setUp(this.plugin)
      const order = []
      const put = env.cache.put
      env.cache.put = async (key, value) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push('cached')
        return put(key, value)
      }
      this.plugin.kafkaProducer.send = async () => {
        order.push('published')
      }
      await save(this.plugin, connectionFor(['a@duotail.com']))
      assert.deepEqual(order, ['cached', 'published'])
    })

    it('releases the claims and answers DENYSOFT when Kafka fails', async function () {
      const env = setUp(this.plugin)
      this.plugin.kafkaProducer.send = async () => {
        throw new Error('broker down')
      }
      const result = await save(
        this.plugin,
        connectionFor(['a@duotail.com', 'b@duotail.com']),
      )
      assert.deepEqual(result, [903, 'Temporary failure, please retry'])
      assert.equal(env.ids.entries.size, 0)

      // The sender's retry is processed.
      this.plugin.kafkaProducer.send = async ({ messages }) => {
        env.sent.push(...messages)
      }
      await save(this.plugin, connectionFor(['a@duotail.com', 'b@duotail.com']))
      assert.equal(env.sent.length, 1)
    })

    it('releases the claims and answers DENYSOFT when the cache write fails', async function () {
      const env = setUp(this.plugin)
      env.cache.put = async () => {
        throw new Error('cache down')
      }
      const result = await save(this.plugin, connectionFor(['a@duotail.com']))
      assert.deepEqual(result, [903, 'Temporary failure, please retry'])
      assert.equal(env.sent.length, 0)
      assert.equal(env.ids.entries.size, 0)
    })

    it('answers DENYSOFT when the message stream fails', async function () {
      const env = setUp(this.plugin)
      const connection = connectionFor(['a@duotail.com'])
      const { EventEmitter } = require('events')
      const stream = new EventEmitter()
      stream.uuid = 'u'
      stream.pipe = () => stream.emit('error', new Error('read failed'))
      connection.transaction.message_stream = stream
      const result = await save(this.plugin, connection)
      assert.deepEqual(result, [903, 'Temporary failure, please retry'])
      assert.equal(env.ids.entries.size, 0)
    })

    it('answers DENYSOFT when the claim itself fails', async function () {
      const env = setUp(this.plugin)
      env.ids.putIfAbsent = async () => {
        throw new Error('hazelcast down')
      }
      const result = await save(this.plugin, connectionFor(['a@duotail.com']))
      assert.deepEqual(result, [903, 'Temporary failure, please retry'])
      assert.equal(env.sent.length, 0)
    })

    it('answers DENYSOFT when Hazelcast is unreachable', async function () {
      const env = setUp(this.plugin)
      this.plugin.connectCacheServer = async () => {
        throw new Error('Hazelcast client could not be restarted')
      }
      const result = await save(this.plugin, connectionFor(['a@duotail.com']))
      assert.deepEqual(result, [903, 'Temporary failure, please retry'])
      assert.equal(env.sent.length, 0)
    })

    it('releases claims made before a later claim fails', async function () {
      const env = setUp(this.plugin)
      const putIfAbsent = env.ids.putIfAbsent
      env.ids.putIfAbsent = async (key, value) => {
        if (key.endsWith('|b@duotail.com')) throw new Error('hazelcast down')
        return putIfAbsent(key, value)
      }
      const result = await save(
        this.plugin,
        connectionFor(['a@duotail.com', 'b@duotail.com']),
      )
      assert.deepEqual(result, [903, 'Temporary failure, please retry'])
      assert.equal(env.ids.entries.size, 0)
    })

    it('releases only its own claims on failure', async function () {
      const env = setUp(this.plugin)
      await save(this.plugin, connectionFor(['a@duotail.com']))
      this.plugin.kafkaProducer.send = async () => {
        throw new Error('broker down')
      }
      await save(this.plugin, connectionFor(['a@duotail.com', 'b@duotail.com']))
      assert.deepEqual(
        [...env.ids.entries.keys()],
        ['<mid-1@gmail.com>|a@duotail.com'],
      )
    })

    it('still answers DENYSOFT when releasing a claim fails', async function () {
      const env = setUp(this.plugin)
      this.plugin.kafkaProducer.send = async () => {
        throw new Error('broker down')
      }
      env.ids.remove = async () => {
        throw new Error('hazelcast down')
      }
      const errors = []
      const connection = connectionFor(['a@duotail.com'])
      connection.logerror = (_plugin, message) => errors.push(message)
      const result = await save(this.plugin, connection)
      assert.deepEqual(result, [903, 'Temporary failure, please retry'])
      assert.ok(errors.some((m) => m.includes('failed to release claim')))
    })

    it('pipeToCache resolves only after the destination finished', async function () {
      let finished = false
      const destination = new Writable({
        write(_chunk, _encoding, callback) {
          callback()
        },
        final(callback) {
          setTimeout(() => {
            finished = true
            callback()
          }, 5)
        },
      })
      await this.plugin.pipeToCache({ pipe: (d) => d.end('x') }, destination)
      assert.ok(finished)
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
