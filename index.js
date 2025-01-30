'use strict'

const { Kafka, logLevel } = require('kafkajs');
const { Client } = require('hazelcast-client');
const { Writable } = require('stream');



exports.register = function () {
  const plugin = this;

  plugin.load_duotail_ini();

  // register hooks here. More info at https://haraka.github.io/core/Plugins/
  plugin.register_hook('queue', 'cache_and_save');
}

exports.cache_and_save = function (next, connection) {
  const plugin = this;

  if (!connection?.transaction) return next();

  const authResults = connection.transaction.notes.get("mailauth");
  
  const spfCheck = plugin.etractSpfResult(authResults);
  const dkimCheck = plugin.extractDkimResult(authResults);

  if (plugin.cfg.main.enabled) {
    const { transaction, remote, hello } = connection;
    const mailFrom = transaction.mail_from;
    const rcptTo = transaction.rcpt_to;
    const remoteIp = remote.ip;
    const remoteHost = remote.host;
    const heloHost = hello?.host;
    const subject = transaction.header.get_all('Subject').length > 0 ? transaction.header.get('Subject').replace(/\n+$/, '') : null;
    const emailId = plugin.generateId();
    const fromHeader = transaction.header.get('From').replace(/\n+$/, '');
    const senderName = fromHeader.replace(/<[^>]*>/g, "").trim();
    const inReplyTo = transaction.header.get('In-Reply-To').replace(/\n+$/, '');

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
      dkimCheck
    }

    const kMessage = {
      key: emailId,
      value: JSON.stringify(kMessageBody),
      headers: {
        'message-version': plugin.cfg.kafka.messageVersion,
        'correlation-id': emailId,
        'haraka-ip': connection.local.ip,
        'haraka-host': connection.local.host,
        '__TypeId__': plugin.cfg.kafka.messageType,
      }
    }

    const topic = plugin.cfg.kafka.topic;

    const saveEmailSummary = async (summaryMessage) => {
      return plugin.kafkaProducer
        .send({
          topic,
          messages: [summaryMessage],
        })
        .then(console.log)
        .catch(e => console.error(`[kafka/sendMessage] ${e.message}`, e))
    }

    const cacheEmail = async (trans, id) => {
      const map = await plugin.hzClient.getMap(plugin.cfg.hazelcast.cacheMapName);
      const cacheStream = plugin.createHazelcastStream(map, id);
      trans.message_stream.pipe(cacheStream, { line_endings: '\n' });
    }

    const run = async (id, sm, trans) => {
      await cacheEmail(trans, id);
      await saveEmailSummary(sm);
      connection.loginfo(plugin, `Done async email processing for: ${id}`);
    }

    setTimeout(() => {
      run(emailId, kMessage, transaction).catch(e => connection.logerror(`[kafka||hazelcast] ${e.message}`, e))
    }, 120000); // 2 minutes timeout

    connection.loginfo(plugin, 'Processed email: ', kMessage);

  } else {
    connection.logdebug(plugin, 'duotail is disabled through configuration')
  }


  next()
}

exports.etractSpfResult = function (authResults) {
  return authResults?.spf?.status?.result ?? 'unknown';
}

exports.extractDkimResult = function (authResults) {
  var results = authResults?.dkim?.results ?? [];
  return results.some(item => item?.status?.result === 'pass') ? 'pass' : 'fail';
}

exports.createHazelcastStream = function (map, key) {
  class HazelcastWritableStream extends Writable {
    constructor(map, key, options) {
      super(options);
      this.map = map;
      this.key = key;
      this.chunks = [];
    }

    _write(chunk, encoding, callback) {
      this.chunks.push(chunk);
      callback();
    }

    async _final(callback) {
      try {
        await this.map.put(this.key, Buffer.concat(this.chunks).toString());
        callback();
      } catch (e) {
        callback(e);
      }
    }
  }

  return new HazelcastWritableStream(map, key);
}

exports.shutdown = function() {
  const plugin = this;

  if (plugin.cfg.main.enabled) {
    const disconnectProducer = async () => {
      await plugin.kafkaProducer.disconnect();
    }

    disconnectProducer().catch(e => console.error(`[kafka/disconnect] ${e.message}`, e))

    const disconnectHazelcast = async () => {
      await plugin.hzClient.shutdown();
    }

    disconnectHazelcast().catch(e => console.error(`[hazelcast/disconnect] ${e.message}`, e))
  }
}


exports.validateKafka = function () {
  const plugin = this;

  if (plugin.cfg.main.enabled) {
    if (!plugin.cfg.kafka.brokers || plugin.cfg.kafka.brokers.length === 0) {
      plugin.failConfiguration('Kafka producer brokers are required');
    }
    if (!plugin.cfg.kafka.topic || plugin.cfg.kafka.topic.length === 0) {
      plugin.failConfiguration('Kafka producer topic is required');
    }

    if (!plugin.cfg.kafka.messageVersion || plugin.cfg.kafka.messageVersion.length === 0) {
      plugin.failConfiguration('Kafka producer messageVersion is required');
    }
  }
}

exports.validateHazelcast = function () {
  const plugin = this;
  if (plugin.cfg.main.enabled) {
    if (!plugin.cfg.hazelcast.clusterName || plugin.cfg.hazelcast.clusterName.length === 0) {
      plugin.failConfiguration('Hazelcast cluster name is required');
    }
    if (!plugin.cfg.hazelcast.clusterMembers || plugin.cfg.hazelcast.clusterMembers.length === 0) {
      plugin.failConfiguration('Hazelcast cluser members are required');
    }
  }
}

exports.failConfiguration = function (message) {
  const plugin = this;
  plugin.cfg.main.enabled = false;
  throw new Error(message);
}

exports.generateId = function () {
  let id = '' + Date.now() + '-';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 15; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return id;
}

exports.load_duotail_ini = function () {
  const plugin = this;

  plugin.cfg = plugin.config.get(
    'duotail.ini',
    {
      booleans: [
        '+enabled', // this.cfg.main.enabled=true
      ]
    },
    () => {
      plugin.load_duotail_ini()
    },
  );

  console.log('config: ' + JSON.stringify(plugin.cfg))

  if (!plugin.cfg.kafka.clientId) {
    plugin.cfg.kafka.clientId = 'haraka'
  }

  if (!Number.isInteger(plugin.cfg.kafka.producerTimeout)) {
    plugin.cfg.kafka.producerTimeout = 30000;
  }

  if (!Number.isInteger(plugin.cfg.kafka.connectionTimeout)) {
    plugin.cfg.kafka.connectionTimeout = 30000;
  }

  if (!plugin.cfg.kafka.messageType) {
    plugin.cfg.kafka.messageType = 'com.duotail.collector.common.model.MessageSummary';
  }

  if (!plugin.cfg.hazelcast.cacheMapName) {
    plugin.cfg.hazelcast.cacheMapName = 'original-email';
  }

  if (!Number.isInteger(plugin.cfg.hazelcast.connectionTimeout)) {
    plugin.cfg.hazelcast.connectionTimeout = 5000;
  }

  if (plugin.cfg.hazelcast.reconnectMode !== 'OFF') {
    plugin.cfg.hazelcast.reconnectMode = 'ON';
  }

  plugin.validateKafka();

  plugin.validateHazelcast();

  if (plugin.cfg.main.enabled) {
    // initialize kafka producer
    const kafka = new Kafka({
      clientId: plugin.cfg.kafka.clientId,
      brokers: plugin.cfg.kafka.brokers.split(','),
      connectionTimeout: plugin.cfg.kafka.connectionTimeout,
      requestTimeout: plugin.cfg.kafka.producerTimeout,
      logLevel: logLevel.WARN,
    });

    plugin.kafkaProducer = kafka.producer({
      allowAutoTopicCreation: false,
    });

    const connectProducer = async () => {
      await plugin.kafkaProducer.connect()
    }

    connectProducer().catch(e => console.error(`[kafka/connect] ${e.message}`, e))

    // initialize hazelcast client
    const hazelcastConfig = {
      clusterName: plugin.cfg.hazelcast.clusterName,
      network: {
        clusterMembers: plugin.cfg.hazelcast.clusterMembers.split(','),
        connectionTimeout: plugin.cfg.hazelcast.connectionTimeout,
      },
      connectionStrategy: {
        asyncStart: false,
        reconnectMode: plugin.cfg.hazelcast.reconnectMode,
      }
    }

    const connectHazelcast = async () => {
      plugin.hzClient = await Client.newHazelcastClient(hazelcastConfig);
    }

    connectHazelcast().catch(e => console.error(`[hazelcast/connect] ${e.message}`, e))

  }

}
