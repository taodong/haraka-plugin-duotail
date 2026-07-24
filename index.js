'use strict'

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
  if (connection?.transaction) connection.transaction.parse_body = true
  next()
}

exports.cache_and_save = function (next, connection) {
  const plugin = this

  if (!connection?.transaction) return next()

  const authResults = connection.transaction.notes.get('mailauth')

  const spfCheck = plugin.etractSpfResult(authResults)
  const dkimCheck = plugin.extractDkimResult(authResults)
  const { inboundType, bounceStatus } = plugin.classifyInbound(
    connection.transaction,
  )

  if (plugin.cfg.main.enabled) {
    const { transaction, remote, hello } = connection
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
    const inReplyTo = transaction.header.get('In-Reply-To').replace(/\n+$/, '')
    const incomingId = transaction.header.get('Message-ID').replace(/\n+$/, '')

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
    }

    const kMessage = {
      key: emailId,
      value: JSON.stringify(kMessageBody),
      headers: {
        'message-version': plugin.cfg.kafka.messageVersion,
        'correlation-id': emailId,
        'haraka-ip': connection.local.ip,
        'haraka-host': connection.local.host,
        __TypeId__: plugin.cfg.kafka.messageType,
      },
    }

    const topic = plugin.cfg.kafka.topic

    const saveEmailSummary = async (summaryMessage) => {
      return plugin.kafkaProducer
        .send({
          topic,
          messages: [summaryMessage],
        })
        .then(console.log)
        .catch((e) => console.error(`[kafka/sendMessage] ${e.message}`, e))
    }

    const cacheOriginalEmailId = async (id) => {
      await plugin.connectCacheServer(connection)
      const map = await plugin.hzClient.getMap(
        plugin.cfg.hazelcast.emailIdCacheMapName,
      )
      const exists = await map.containsKey(id)
      if (exists) {
        return -1
      } else {
        await map.put(id, true)
        return 1
      }
    }

    const cacheEmail = async (message_stream, id) => {
      await plugin.connectCacheServer(connection)
      const map = await plugin.hzClient.getMap(
        plugin.cfg.hazelcast.cacheMapName,
      )
      const cacheStream = plugin.createHazelcastStream(map, id)

      console.log(`Haraka readable stream id is ${message_stream.uuid}`)

      message_stream.pipe(cacheStream, { line_endings: '\n' })
    }

    const run = async (id, incomingId, sm, trans) => {
      if (incomingId) {
        const cacheResult = await cacheOriginalEmailId(incomingId)
        if (cacheResult === 1) {
          await cacheEmail(trans.message_stream, id)
          await saveEmailSummary(sm)
          connection.loginfo(plugin, `Done async email processing for: ${id}`)
          next()
        } else {
          connection.loginfo(
            plugin,
            `Email with incomingId ${incomingId} is already processed.`,
          )
          next()
        }
      } else {
        // If no incomingId, proceed as before
        await cacheEmail(trans.message_stream, id)
        await saveEmailSummary(sm)
        connection.loginfo(plugin, `Done async email processing for: ${id}`)
        next()
      }
    }

    run(emailId, incomingId, kMessage, transaction).catch((e) =>
      connection.logerror(`[kafka||hazelcast] ${e.message}`, e),
    )

    connection.loginfo(plugin, 'Processed email: ', kMessage)
  } else {
    connection.logdebug(plugin, 'duotail is disabled through configuration')
    next()
  }
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

// Classify an inbound message into one of five types and, for delivery-status
// reports, extract the RFC 3463 status code. See docs/design/message-classification.md.
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
  if (
    exports.isNullSender(transaction) &&
    exports.findMimePart(body, 'message/delivery-status')
  ) {
    return {
      inboundType: 'DSN',
      bounceStatus: exports.extractDsnStatus(
        exports.findMimePart(body, 'message/delivery-status'),
      ),
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
