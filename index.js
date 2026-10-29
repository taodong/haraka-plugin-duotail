'use strict'

const { Address } = require('address-rfc2821')
const constants = require('haraka-constants')
const parseAddresses = require('email-addresses')
const { Kafka, logLevel } = require('kafkajs')
const { Client } = require('hazelcast-client')
const { Writable } = require('stream')

exports.register = function () {
  const plugin = this

  plugin.load_duotail_ini()

  // register hooks here. More info at https://haraka.github.io/core/Plugins/
  // Enable MIME body parsing so cache_and_save can inspect DSN/MDN report parts.
  plugin.register_hook('data', 'enable_body_parsing')
  plugin.register_hook('queue', 'cache_and_save')
}

exports.enable_body_parsing = function (next, connection) {
  if (this?.cfg?.main?.enabled && connection?.transaction) {
    connection.transaction.parse_body = true
  }
  next()
}

exports.cache_and_save = function (next, connection) {
  const plugin = this

  if (!connection?.transaction) return next()

  const authResults = connection.transaction.notes.get('mailauth')

  const spfCheck = plugin.etractSpfResult(authResults)
  const dkimCheck = plugin.extractDkimResult(authResults)
  const dkimDomains = plugin.extractDkimDomains(authResults)

  if (plugin.cfg.main.enabled) {
    const { transaction, remote, hello } = connection
    const { inboundType, bounceStatus } = plugin.classifyInbound(transaction)
    const mailFrom = transaction.mail_from
    const rcptTo = transaction.rcpt_to
    const remoteIp = remote.ip
    const remoteHost = remote.host
    const heloHost = hello?.host
    const subject =
      transaction.header.get_all('Subject').length > 0
        ? transaction.header.get('Subject').replace(/\n+$/, '')
        : null
    const emailId = plugin.generateId()
    const fromHeader = transaction.header.get('From').replace(/\n+$/, '')
    const senderName = fromHeader.replace(/<[^>]*>/g, '').trim()
    const headerFrom = plugin.parseHeaderFrom(transaction)
    const headerRecipients = plugin.parseHeaderRecipients(transaction)
    const inReplyTo = transaction.header.get('In-Reply-To').replace(/\n+$/, '')
    const incomingId = transaction.header.get('Message-ID').replace(/\n+$/, '')

    // rcptTo is replaced by the recipients this transaction claimed (buildKafkaMessage).
    const kMessageBody = {
      emailId,
      mailFrom,
      rcptTo,
      remoteIp,
      remoteHost,
      heloHost,
      subject,
      senderName,
      inReplyTo,
      spfCheck,
      dkimCheck,
      inboundType,
      bounceStatus,
      incomingId,
      headerFrom,
      dkimDomains,
      headerRecipients,
    }

    const buildKafkaMessage = (recipients) => ({
      key: emailId,
      value: JSON.stringify({ ...kMessageBody, rcptTo: recipients }),
      headers: {
        'message-version': plugin.cfg.kafka.messageVersion,
        'correlation-id': emailId,
        'haraka-ip': connection.local.ip,
        'haraka-host': connection.local.host,
        __TypeId__: plugin.cfg.kafka.messageType,
      },
    })

    const topic = plugin.cfg.kafka.topic

    // Rejects on failure, so the transaction is answered DENYSOFT and the sender retries.
    const saveEmailSummary = async (summaryMessage) => {
      const result = await plugin.kafkaProducer.send({
        topic,
        messages: [summaryMessage],
      })
      console.log(result)
    }

    const getEmailIdMap = async () => {
      await plugin.connectCacheServer(connection)
      return plugin.hzClient.getMap(plugin.cfg.hazelcast.emailIdCacheMapName)
    }

    // Resolves once the whole message is in the cache, so the summary is never published
    // before the copy the collector reads exists.
    const cacheEmail = async (message_stream, id) => {
      await plugin.connectCacheServer(connection)
      const map = await plugin.hzClient.getMap(
        plugin.cfg.hazelcast.cacheMapName,
      )
      const cacheStream = plugin.createHazelcastStream(map, id)

      console.log(`Haraka readable stream id is ${message_stream.uuid}`)

      await plugin.pipeToCache(message_stream, cacheStream)
    }

    const publish = async (recipients) => {
      const kMessage = buildKafkaMessage(recipients)
      connection.loginfo(plugin, 'Processed email: ', kMessage)
      await cacheEmail(transaction.message_stream, emailId)
      await saveEmailSummary(kMessage)
      connection.loginfo(plugin, `Done async email processing for: ${emailId}`)
    }

    // A remote server may split one email over several transactions (Gmail reply-all sends
    // each recipient on its own connection), all with the same Message-ID. Each recipient is
    // claimed once, so a split delivers every recipient and a repeat of the same delivery is
    // dropped. Claims expire with the map's TTL, which is set on the Hazelcast member.
    const run = async () => {
      if (!incomingId) {
        await publish(rcptTo)
        return
      }

      const claimedKeys = []
      let map
      try {
        map = await getEmailIdMap()
        const claimed = await plugin.claimRecipients(
          map,
          incomingId,
          rcptTo,
          claimedKeys,
        )
        if (claimed.length === 0) {
          connection.loginfo(
            plugin,
            `Email with incomingId ${incomingId} is already processed for ${plugin.recipientAddresses(rcptTo)}.`,
          )
          return
        }
        if (claimed.length < rcptTo.length) {
          connection.loginfo(
            plugin,
            `Email with incomingId ${incomingId} is already processed for some recipients; forwarding only ${plugin.recipientAddresses(claimed)}.`,
          )
        }
        await publish(claimed)
      } catch (e) {
        await plugin.releaseClaims(map, claimedKeys, connection)
        throw e
      }
    }

    // next is called exactly once: the success handler is not covered by the failure handler.
    run().then(
      () => next(),
      (e) => {
        connection.logerror(plugin, `[kafka||hazelcast] ${e.message}`, e)
        next(constants.denysoft, exports.TEMPORARY_FAILURE_MESSAGE)
      },
    )
  } else {
    connection.logdebug(plugin, 'duotail is disabled through configuration')
    next()
  }
}

exports.TEMPORARY_FAILURE_MESSAGE = 'Temporary failure, please retry'

// The de-duplication key of one envelope recipient of an email. Case-insensitive: two
// addresses that differ only in case are the same mailbox.
exports.recipientKey = function (incomingId, rcpt) {
  return `${incomingId}|${exports.recipientAddress(rcpt).toLowerCase()}`
}

exports.recipientAddress = function (rcpt) {
  if (typeof rcpt?.address === 'function') return rcpt.address()
  return rcpt?.host ? `${rcpt.user}@${rcpt.host}` : String(rcpt?.user ?? '')
}

exports.recipientAddresses = function (rcptTo) {
  return rcptTo.map((rcpt) => exports.recipientAddress(rcpt)).join(', ')
}

// Claims every recipient no earlier transaction of this email has claimed, with an atomic
// putIfAbsent, and returns those recipients in envelope order. Each key this call stored is
// pushed onto claimedKeys as soon as it is stored, so a caller can release them when a later
// step (or a later claim) fails. A recipient listed twice in one envelope is forwarded once.
exports.claimRecipients = async function (
  map,
  incomingId,
  rcptTo,
  claimedKeys,
) {
  const claimed = []
  for (const rcpt of rcptTo) {
    const key = exports.recipientKey(incomingId, rcpt)
    if (claimedKeys.includes(key)) continue
    const previous = await map.putIfAbsent(key, true)
    if (previous === null || previous === undefined) {
      claimedKeys.push(key)
      claimed.push(rcpt)
    }
  }
  return claimed
}

// Removes the keys this transaction claimed, so the sender's retry is processed. Never throws:
// when Hazelcast is unreachable the keys expire with the map's TTL instead.
exports.releaseClaims = async function (map, claimedKeys, connection) {
  if (!map || claimedKeys.length === 0) return
  for (const key of claimedKeys) {
    try {
      await map.remove(key)
    } catch (e) {
      connection.logerror(
        this,
        `[hazelcast] failed to release claim ${key}: ${e.message}`,
        e,
      )
    }
  }
}

// Pipes the message into the cache stream and resolves when the stream has written it
// (its _final put finished); rejects when either stream fails.
exports.pipeToCache = function (messageStream, cacheStream) {
  return new Promise((resolve, reject) => {
    cacheStream.once('finish', resolve)
    cacheStream.once('error', reject)
    messageStream.once?.('error', reject)
    messageStream.pipe(cacheStream, { line_endings: '\n' })
  })
}

exports.etractSpfResult = function (authResults) {
  return authResults?.spf?.status?.result ?? 'unknown'
}

exports.extractDkimResult = function (authResults) {
  var results = authResults?.dkim?.results ?? []
  return results.some((item) => item?.status?.result === 'pass')
    ? 'pass'
    : 'fail'
}

// The signing domains (d=) of every DKIM signature that verified, lower-cased and
// de-duplicated. Downstream uses them to tell which domain vouched for the message;
// dkimCheck alone only says that some signature passed.
exports.extractDkimDomains = function (authResults) {
  const results = authResults?.dkim?.results ?? []
  const domains = results
    .filter((item) => item?.status?.result === 'pass' && item?.signingDomain)
    .map((item) => String(item.signingDomain).trim().toLowerCase())
  return [...new Set(domains)]
}

// The first mailbox of the From header, built with address-rfc2821 like Haraka's
// mail_from/rcpt_to so the collector deserializes it as a Contact. The addr-spec is taken
// verbatim from the header, so a quoted local part keeps its quotes and spacing. A From
// field may list several mailboxes or a group; the first mailbox wins. Null when the
// header is absent, unparseable, or its address is not a valid RFC 5321 mailbox.
// A message with more than one From header, even an empty one, yields null: a DKIM
// signature covers only the bottom-most From, so an extra From prepended to a replayed
// signed message must never become the sender. Instances are counted with get_all,
// because get joins them with "\n" and an empty one leaves only a blank line. Haraka
// keeps folded lines as "\n ", so the value is unfolded (RFC 5322 §2.2.3) first.
exports.parseHeaderFrom = function (transaction) {
  const instances = transaction?.header?.get_all?.('From') ?? []
  if (instances.length !== 1) return null
  const mailbox = exports.parseMailboxParts(instances[0])[0]
  return mailbox ? exports.toAddress(mailbox) : null
}

// The To and Cc mailboxes, To first, in header order, every instance of each header, built
// like headerFrom so the collector deserializes them as Contacts. A group's members count as
// mailboxes; an address that is not a valid RFC 5321 mailbox is left out. The collector reads
// reply-all participants from them: a reply-all split over several transactions may carry
// only some participants in its envelope, but every one of them in To/Cc.
exports.parseHeaderRecipients = function (transaction) {
  const recipients = []
  for (const name of ['To', 'Cc']) {
    for (const instance of transaction?.header?.get_all?.(name) ?? []) {
      for (const mailbox of exports.parseMailboxParts(instance)) {
        const address = exports.toAddress(mailbox)
        if (address) recipients.push(address)
      }
    }
  }
  return recipients
}

// The { local, domain } of every mailbox of one address-list header value, in order, groups
// flattened. Haraka keeps folded lines as "\n ", so the value is unfolded (RFC 5322 §2.2.3)
// first. The addr-spec is taken verbatim, so a quoted local part keeps its quotes and spacing.
exports.parseMailboxParts = function (headerValue) {
  const value = String(headerValue ?? '')
    .replace(/\r?\n(?=[ \t])/g, '')
    .trim()
  if (!value) return []

  // Same parser options address-rfc2822 uses, which discards the raw local part.
  const parsed = parseAddresses({
    input: value,
    rfc6532: true,
    partial: false,
    simple: false,
    strict: false,
    rejectTLD: false,
    atInDisplayName: true,
    commaInDisplayName: false,
  })
  return (parsed?.addresses ?? [])
    .flatMap((entry) => (entry.type === 'group' ? entry.addresses : [entry]))
    .filter((entry) => entry?.parts?.local && entry?.parts?.domain)
    .map((entry) => ({
      local: entry.parts.local.tokens.trim(),
      domain: entry.parts.domain.tokens.trim(),
    }))
}

// A plain copy of an Address's own fields, which is exactly what JSON.stringify(mail_from)
// emits; null when the mailbox is not a valid RFC 5321 address.
exports.toAddress = function ({ local, domain }) {
  try {
    return { ...new Address(`<${local}@${domain}>`) }
  } catch {
    return null
  }
}

// Classify an inbound message into one of five types and, for delivery-status
// reports, extract the RFC 3463 status code. See README.md#inbound-message-classification.
// Rules are evaluated in order; the first match wins.
//   1. DSN            — null envelope sender + a message/delivery-status part
//   2. MDN            — a message/disposition-notification part
//   3. AUTO_REPLY     — Auto-Submitted: auto-replied, or X-Autoreply/X-Autorespond
//   4. AUTO_GENERATED — Auto-Submitted: auto-generated, or Precedence bulk/list/junk
//   5. NORMAL         — otherwise
exports.classifyInbound = function (transaction) {
  const body = transaction?.body

  // 1. DSN (RFC 3464/3463): a genuine delivery-status report always carries a
  // null return-path AND a machine-readable message/delivery-status part.
  const dsnPart = exports.findMimePart(body, 'message/delivery-status')
  if (exports.isNullSender(transaction) && dsnPart) {
    return {
      inboundType: 'DSN',
      bounceStatus: exports.extractDsnStatus(dsnPart),
    }
  }

  // 2. MDN (RFC 8098): read-receipt / disposition notification.
  if (exports.findMimePart(body, 'message/disposition-notification')) {
    return { inboundType: 'MDN', bounceStatus: null }
  }

  const autoSubmitted = exports.headerToken(transaction, 'Auto-Submitted')

  // 3. AUTO_REPLY (RFC 3834). The envelope sender is intentionally not tested —
  // a null return-path is normal for an out-of-office reply (RFC 3834 §4).
  if (
    autoSubmitted === 'auto-replied' ||
    exports.hasHeader(transaction, 'X-Autoreply') ||
    exports.hasHeader(transaction, 'X-Autorespond')
  ) {
    return { inboundType: 'AUTO_REPLY', bounceStatus: null }
  }

  // 4. AUTO_GENERATED. X-Auto-Response-Suppress is deliberately excluded: it is a
  // sender directive ("do not auto-respond to me"), not an auto-reply marker.
  const precedence = exports.headerValue(transaction, 'Precedence')
  if (
    autoSubmitted === 'auto-generated' ||
    ['bulk', 'list', 'junk'].includes(precedence)
  ) {
    return { inboundType: 'AUTO_GENERATED', bounceStatus: null }
  }

  // 5. NORMAL
  return { inboundType: 'NORMAL', bounceStatus: null }
}

// True when the envelope MAIL FROM is null ("<>"). Reads the address directly,
// removing the need for haraka-plugin-bounce's `isa` verdict.
exports.isNullSender = function (transaction) {
  const mailFrom = transaction?.mail_from
  if (!mailFrom) return false
  if (typeof mailFrom.isNull === 'function') return mailFrom.isNull()
  // Fallback for plain-object test doubles.
  if (mailFrom.original !== undefined) {
    return mailFrom.original === '' || mailFrom.original === '<>'
  }
  return !mailFrom.user && !mailFrom.host
}

// The media type (lower-cased, parameters stripped) of a MIME part's Content-Type.
exports.mediaType = function (contentType) {
  return String(contentType || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
}

// Depth-first search of the parsed MIME tree for a part whose media type matches.
exports.findMimePart = function (body, mediaType) {
  if (!body) return null
  if (exports.mediaType(body.ct) === mediaType) return body
  for (const child of body.children ?? []) {
    const found = exports.findMimePart(child, mediaType)
    if (found) return found
  }
  return null
}

// Extract the RFC 3463 status code (e.g. "5.1.1") from a message/delivery-status
// part. Reads only that part's text so a matching string in the embedded original
// message cannot cause a false positive. Returns null when absent/unparseable.
exports.extractDsnStatus = function (part) {
  const text = part?.bodytext ?? ''
  const match = text.match(/^Status:\s*(\d\.\d{1,3}\.\d{1,3})/im)
  return match ? match[1] : null
}

// Normalized header value: whitespace collapsed, trimmed, lower-cased.
exports.headerValue = function (transaction, name) {
  const raw = transaction?.header?.get?.(name) ?? ''
  return String(raw).replace(/\s+/g, ' ').trim().toLowerCase()
}

// First token of a structured header value (the part before any ";" parameters).
exports.headerToken = function (transaction, name) {
  return exports.headerValue(transaction, name).split(';', 1)[0].trim()
}

// True when a header is present with a non-empty value.
exports.hasHeader = function (transaction, name) {
  const raw = transaction?.header?.get?.(name)
  return raw !== undefined && String(raw).trim() !== ''
}

exports.createHazelcastStream = function (map, key) {
  class HazelcastWritableStream extends Writable {
    constructor(map, key, options) {
      super(options)
      this.map = map
      this.key = key
      this.chunks = []
    }

    _write(chunk, encoding, callback) {
      this.chunks.push(chunk)
      callback()
    }

    async _final(callback) {
      try {
        await this.map.put(this.key, Buffer.concat(this.chunks).toString())
        callback()
      } catch (e) {
        callback(e)
      }
    }
  }

  return new HazelcastWritableStream(map, key)
}

exports.shutdown = function () {
  const plugin = this
  console.log('Shutting down duotail plugin...')

  if (plugin.cfg.main.enabled) {
    if (plugin.kafkaProducer) {
      const disconnectProducer = async () => {
        await plugin.kafkaProducer.disconnect()
      }

      disconnectProducer().catch((e) =>
        console.error(`[kafka/disconnect] ${e.message}`, e),
      )
    }

    if (plugin.hzClient && plugin.hzClient.getLifecycleService().isRunning()) {
      const disconnectHazelcast = async () => {
        await plugin.hzClient.shutdown()
      }

      disconnectHazelcast().catch((e) =>
        console.error(`[hazelcast/disconnect] ${e.message}`, e),
      )
    }
  }
}

exports.validateKafka = function () {
  const plugin = this

  if (plugin.cfg.main.enabled) {
    if (!plugin.cfg.kafka.brokers || plugin.cfg.kafka.brokers.length === 0) {
      plugin.failConfiguration('Kafka producer brokers are required')
    }
    if (!plugin.cfg.kafka.topic || plugin.cfg.kafka.topic.length === 0) {
      plugin.failConfiguration('Kafka producer topic is required')
    }

    if (
      !plugin.cfg.kafka.messageVersion ||
      plugin.cfg.kafka.messageVersion.length === 0
    ) {
      plugin.failConfiguration('Kafka producer messageVersion is required')
    }
  }
}

exports.validateHazelcast = function () {
  const plugin = this
  if (plugin.cfg.main.enabled) {
    if (
      !plugin.cfg.hazelcast.clusterName ||
      plugin.cfg.hazelcast.clusterName.length === 0
    ) {
      plugin.failConfiguration('Hazelcast cluster name is required')
    }
    if (
      !plugin.cfg.hazelcast.clusterMembers ||
      plugin.cfg.hazelcast.clusterMembers.length === 0
    ) {
      plugin.failConfiguration('Hazelcast cluser members are required')
    }
  }
}

exports.failConfiguration = function (message) {
  const plugin = this
  plugin.cfg.main.enabled = false
  throw new Error(message)
}

exports.generateId = function () {
  let id = '' + Date.now() + '-'
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 15; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length))
  }

  return id
}

exports.load_duotail_ini = function () {
  const plugin = this

  plugin.cfg = plugin.config.get(
    'duotail.ini',
    {
      booleans: [
        '+enabled', // this.cfg.main.enabled=true
      ],
    },
    () => {
      plugin.load_duotail_ini()
    },
  )

  console.log('Loaded plugin config: ' + JSON.stringify(plugin.cfg))

  if (plugin.cfg.main.enabled) {
    if (!plugin.cfg.kafka.clientId) {
      plugin.cfg.kafka.clientId = 'haraka'
    }

    if (!Number.isInteger(plugin.cfg.kafka.producerTimeout)) {
      plugin.cfg.kafka.producerTimeout = 30000
    }

    if (!Number.isInteger(plugin.cfg.kafka.connectTimeout)) {
      plugin.cfg.kafka.connectTimeout = 30000
    }

    if (!plugin.cfg.kafka.messageType) {
      plugin.cfg.kafka.messageType =
        'com.duotail.collector.common.model.MessageSummary'
    }

    if (!plugin.cfg.hazelcast.cacheMapName) {
      plugin.cfg.hazelcast.cacheMapName = 'original-email'
    }

    if (!plugin.cfg.hazelcast.emailIdCacheMapName) {
      plugin.cfg.hazelcast.emailIdCacheMapName = 'income-message-ids'
    }

    if (!Number.isInteger(plugin.cfg.hazelcast.connectTimeout)) {
      plugin.cfg.hazelcast.connectTimeout = 50000
    }

    if (plugin.cfg.hazelcast.reconnectMode !== 'OFF') {
      plugin.cfg.hazelcast.reconnectMode = 'ON'
    }

    if (!Number.isInteger(plugin.cfg.hazelcast.clusterConnectionTimeout)) {
      plugin.cfg.hazelcast.clusterConnectionTimeout = 50000
    }

    plugin.validateKafka()

    plugin.validateHazelcast()

    // initialize kafka producer
    const kafkaConfig = {
      clientId: plugin.cfg.kafka.clientId,
      brokers: plugin.cfg.kafka.brokers
        .split(',')
        .map((broker) => broker.trim()),
      connectionTimeout: plugin.cfg.kafka.connectTimeout,
      requestTimeout: plugin.cfg.kafka.producerTimeout,
      logLevel: logLevel.WARN,
    }

    console.log('Apply Kafka configuration: ' + JSON.stringify(kafkaConfig))

    const kafka = new Kafka(kafkaConfig)

    plugin.kafkaProducer = kafka.producer({
      allowAutoTopicCreation: false,
    })

    const connectProducer = async () => {
      await plugin.kafkaProducer.connect()
    }

    connectProducer().catch((e) => {
      console.error(`[kafka/connect] ${e.message}`, e)
      plugin.shutdown()
      throw new Error('Kafka producer could not be started')
    })

    // initialize hazelcast client
    const hazelcastConfig = {
      clusterName: plugin.cfg.hazelcast.clusterName,
      network: {
        clusterMembers: plugin.cfg.hazelcast.clusterMembers
          .split(',')
          .map((member) => member.trim()),
        connectionTimeout: plugin.cfg.hazelcast.connectTimeout,
      },
      connectionStrategy: {
        asyncStart: false,
        reconnectMode: plugin.cfg.hazelcast.reconnectMode,
        connectionRetry: {
          clusterConnectTimeoutMillis:
            plugin.cfg.hazelcast.clusterConnectionTimeout,
        },
      },
    }

    plugin.hzConfig = hazelcastConfig

    console.log(
      'Apply Hazelcast configuration: ' + JSON.stringify(plugin.hzConfig),
    )

    // moved Hazelcast connection logic to connectCacheServer()
    plugin.connectCacheServer().catch((e) => {
      console.error(`[hazelcast/connect] ${e.message}`, e)
      plugin.shutdown()
      throw new Error('Hazelcast client could not be started')
    })
  }
}

// Add connectCacheServer function
exports.connectCacheServer = async function (connection) {
  const plugin = this
  if (
    !plugin.hzClient ||
    plugin.hzClient.getLifecycleService().isRunning() === false
  ) {
    if (connection) {
      connection.loginfo(
        plugin,
        'Hazelcast client is not initialized or not running. Restarting...',
      )
    } else {
      console.log(
        'Hazelcast client is not initialized or not running. Restarting...',
      )
    }
    try {
      plugin.hzClient = await Client.newHazelcastClient(plugin.hzConfig)
      if (connection) {
        connection.loginfo(plugin, 'Hazelcast client restarted successfully.')
      } else {
        console.log('Hazelcast client restarted successfully.')
      }
    } catch (e) {
      if (connection) {
        connection.logerror(
          plugin,
          `Failed to restart Hazelcast client: ${e.message}`,
          e,
        )
      } else {
        console.error(`Failed to restart Hazelcast client: ${e.message}`, e)
      }
      throw new Error('Hazelcast client could not be restarted')
    }
  }
}
