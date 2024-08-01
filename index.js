'use strict'


const { Kafka, logLevel } = require('kafkajs');

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
    const emailId = this.generateId();

    const kMessageBody = {
      emailId,
      mailFrom,
      rcptTo,
      remoteIp,
      remoteHost,
      heloHost,
      subject,
    }

    const kMessage = {
      key: emailId,
      value: JSON.stringify(kMessageBody),
      headers: {
        'message-version': this.cfg.main.messageVersion,
        'correlation-id': emailId,
        'haraka-ip': connection.local.ip,
        'haraka-host': connection.local.host,
        '__TypeId__': Buffer.from('com.duotail.collector.common.model.MessageSummary')
      }
    }

    const topic = this.cfg.main.topic;

    const sendMessage = () => {
      return this.kafkaProducer
        .send({
          topic,
          messages: [kMessage],
        })
        .then(console.log)
        .catch(e => console.error(`[kafka/sendMessage] ${e.message}`, e))
    }

    const run = async () => {
      await sendMessage();
    }

    run().catch(e => connection.logerror(`[kafka/sendMessage] ${e.message}`, e))


    connection.loginfo(this, 'Sent Kafka message: ', kMessage);

  } else {
    connection.logdebug(this, 'duotail is disabled through configuration')
  }


  next()
}

exports.shutdown = function() {
  if (this.cfg.main.enabled) {
    const disconnectProducer = async () => {
    await this.kafkaProducer.disconnect();
    }

    disconnectProducer().catch(e => console.error(`[kafka/disconnect] ${e.message}`, e))
  }
}


exports.validateKafka = function () {
  if (this.cfg.main.enabled) {
    if (!this.cfg.main.brokers || this.cfg.main.brokers.length === 0) {
      this.failConfiguration('Kafka producer brokers are required');
    }
    if (!this.cfg.main.topic || this.cfg.main.topic.length === 0) {
      this.failConfiguration('Kafka producer topic is required');
    }

    if (!this.cfg.main.messageVersion || this.cfg.main.messageVersion.length === 0) {
      this.failConfiguration('Kafka producer messageVersion is required');
    }
  }
}

exports.failConfiguration = function (message) {
  this.cfg.main.enabled = false;
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
  );

  console.log('config: ' + JSON.stringify(this.cfg))

  if (!this.cfg.main.clientId) {
    this.cfg.main.clientId = 'haraka'
  }

  if (!Number.isInteger(this.cfg.main.producerTimeout)) {
    this.cfg.main.producerTimeout = 30000;
  }

  if (!Number.isInteger(this.cfg.main.connectionTimeout)) {
    this.cfg.main.connectionTimeout = 30000;
  }

  this.validateKafka();

  // initialize kafka producer
  if (this.cfg.main.enabled) {

    const kafka = new Kafka({
      clientId: this.cfg.main.clientId,
      brokers: this.cfg.main.brokers.split(','),
      connectionTimeout: this.cfg.main.connectionTimeout,
      requestTimeout: this.cfg.main.producerTimeout,
      logLevel: logLevel.WARN,
    });

    this.kafkaProducer = kafka.producer({
      allowAutoTopicCreation: false,
    });

    const connectProducer = async () => {
      await this.kafkaProducer.connect()
    }

    connectProducer().catch(e => console.error(`[kafka/connect] ${e.message}`, e))

  }

}
