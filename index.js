'use strict'


const { Kafka } = require('kafkajs');

exports.register = function () {
  this.load_duotail_ini();

  // register hooks here. More info at https://haraka.github.io/core/Plugins/
  this.register_hook('queue', 'cache_message_queue_skeleton');
}

exports.cache_message_queue_skeleton = function (next, connection) {

  if (this.cfg.main.enabled) {
    const { transaction, remote, hello } = connection;
    const mailFrom = transaction.mail_from;
    const rcptTo = transaction.rcpt_to;
    const remoteIp = remote.ip;
    const remoteHost = remote.host;
    const heloHost = hello?.host;
    const subject = transaction.header.get_all('Subject').length > 0 ? transaction.header.get('Subject') : null;

    const messageSkeleton = {
      mailFrom,
      rcptTo,
      remoteIp,
      remoteHost,
      heloHost,
      subject,
    };

    connection.loginfo(this, 'message skeleton: ', messageSkeleton);

  } else {
    connection.logdebug(this, 'duotail is disabled through configuration')
  }


  next()
}

// kafkaProducer is an object to store Kafka producer configuration, which has get and set methods for properties: clientId, messageVersion, brokers, topic, producerTimeout and connectionTimeout.
// Default values of properties are: clientId = 'duotail', producerTimeout = 30000 ms, connectionTimeout = 30000 ms, messageVersion = 0.0.1.
// validate function is used to validate the configuration of Kafka producer.
exports.kafkaProducer = {
  get clientId() {
    return this._clientId || 'duotail';
  },
  set clientId(value) {
    this._clientId = value;
  },
  get brokers() {
    return this._brokers || ['localhost:9092'];
  },
  set brokers(value) {
    this._brokers = value;
  },
  get topic() {
    return this._topic || 'duotail';
  },
  set topic(value) {
    this._topic = value;
  },
  get producerTimeout() {
    return this._producerTimeout || 30000;
  },
  set producerTimeout(value) {
    this._producerTimeout = parseInt(value) || 30000;
  },
  get connectionTimeout() {
    return this._connectionTimeout || 30000;
  },
  set connectionTimeout(value) {
    this._connectionTimeout = parseInt(value) || 30000;
  },
  get messageVersion() {
    return this._messageVersion || '0.0.1';
  },
  set messageVersion(value) {
    this._messageVersion = value;
  }
};

exports.validate = function (kafkaProducer) {

  if (kafkaProducer.brokers || this.brokers.length === 0) {
    throw new Error('Kafka producer brokers are required');
  }
  if (kafkaProducer.topic) {
    throw new Error('Kafka producer topic is required');
  }
}

exports.load_duotail_ini = function () {
  this.cfg = this.config.get(
    'duotail.ini',
    {
      booleans: [
        '+enabled', // this.cfg.main.enabled=true
      ]
    },
    () => {
      this.load_duotail_ini()
    },
  )
}
